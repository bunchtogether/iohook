'use strict';

const path = require('path');
const os = require('os');
const nugget = require('nugget');
const rc = require('rc');
const pump = require('pump');
const tfs = require('tar-fs');
const zlib = require('zlib');
const nodeAbi = require('node-abi');
const fs = require('fs-extra');
const tar = require('tar');
const pkg = require('./package.json');
const spawn = require('child_process').spawn;
const supportedTargets = require('./package.json').supportedTargets;
const { optionsFromPackage } = require('./helpers');

const FILES_TO_ARCHIVE = {
  "win32": ['build/Release/iohook.node', 'build/Release/uiohook.dll'],
  "linux": ['build/Release/iohook.node', 'build/Release/uiohook.so'],
  "darwin": ['build/Release/iohook.node', 'build/Release/uiohook.dylib'],
}

let gypJsPath = path.join(
  __dirname,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp'
);

function cpGyp() {
  try {
    fs.unlinkSync(path.join(__dirname, 'binding.gyp'));
    fs.unlinkSync(path.join(__dirname, 'uiohook.gyp'));
  } catch(e) {
  }
  switch (process.platform) {
    case 'win32':
    case 'darwin':
      fs.copySync(path.join(__dirname, 'build_def', process.platform, 'binding.gyp'), path.join(__dirname, 'binding.gyp'));
      fs.copySync(path.join(__dirname, 'build_def', process.platform, 'uiohook.gyp'), path.join(__dirname, 'uiohook.gyp'));
      break;
    default:
      fs.copySync(path.join(__dirname, 'build_def', 'linux', 'binding.gyp'), path.join(__dirname, 'binding.gyp'));
      fs.copySync(path.join(__dirname, 'build_def', 'linux', 'uiohook.gyp'), path.join(__dirname, 'uiohook.gyp'));
      break;
  }
}

function build(runtime, version, abi, arch) {
  cpGyp();
  return new Promise(function (resolve, reject) {
  let args = [
      'configure', 'rebuild',
      '--target=' + version,
      '--arch=' + arch
  ];

    if (/^electron/i.test(runtime)) {
    args.push('--dist-url=https://atom.io/download/electron');
    }

    if (parseInt(abi) >= 80) {
      if (arch === "x64") {
      args.push('--v8_enable_pointer_compression=1');
      } else {
      args.push('--v8_enable_pointer_compression=0');
      args.push('--v8_enable_31bit_smis_on_64bit_arch=1');
      }
    }
    if (process.platform !== "win32") {
      if (parseInt(abi) >= 64) {
      args.push('--build_v8_with_gn=false');
      }
      if (parseInt(abi) >= 67) {
      args.push('--enable_lto=false');
      }
    }

    console.log('Compiling iohook for ' + runtime + ' v' + version + '>>>>');
  if (process.platform === 'win32') {
    if (version.split('.')[0] >= 4) {
      process.env.msvs_toolset = 15
      process.env.msvs_version = 2017
    } else {
      process.env.msvs_toolset = 12
      process.env.msvs_version = 2013
    }
    args.push('--msvs_version=' + process.env.msvs_version);
  } else {
    process.env.gyp_iohook_runtime = runtime;
    process.env.gyp_iohook_abi = abi;
    process.env.gyp_iohook_platform = process.platform;
    process.env.gyp_iohook_arch = arch;
  }

    let proc = spawn(gypJsPath, args, {
      env: process.env
    });
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
    proc.on('exit', function (code, sig) {
      if (code === 1) {
        return reject(new Error('Failed to build...'))
      }
      resolve()
    })
  })
}

function onerror(err) {
  throw err;
}

/**
 * Download and Install prebuild
 * @param runtime
 * @param abi
 * @param platform
 * @param arch
 * @param cb Callback
 */
function install(runtime, abi, platform, arch, cb) {
  const essential = runtime + '-v' + abi + '-' + platform + '-' + arch;
  const pkgVersion = pkg.version;
  const currentPlatform = pkg.name + '-v' + pkgVersion + '-' + essential;

  console.log('Downloading prebuild for platform:', currentPlatform);
  let downloadUrl = 'https://github.com/intermedia-net/iohook/releases/download/v' + pkgVersion + '/' + currentPlatform + '.tar.gz';

  let nuggetOpts = {
    dir: os.tmpdir(),
    target: 'prebuild.tar.gz',
    strictSSL: true
  };

  let npmrc = {};

  try {
    rc('npm', npmrc);
  } catch (error) {
    console.warn('Error reading npm configuration: ' + error.message);
  }

  if (npmrc && npmrc.proxy) {
    nuggetOpts.proxy = npmrc.proxy;
  }

  if (npmrc && npmrc['https-proxy']) {
    nuggetOpts.proxy = npmrc['https-proxy'];
  }

  if (npmrc && npmrc['strict-ssl'] === false) {
    nuggetOpts.strictSSL = false;
  }

  nugget(downloadUrl, nuggetOpts, async function(errors) {
     
    let targetFile = path.join(__dirname, 'builds', essential);

    if (errors) {
      const error = errors[0];

      if (error.message.indexOf('404') === -1) {
        onerror(error);
      } else {
        console.error('Prebuild for current platform (' + currentPlatform + ') not found!');
        console.error('Trying to compile for your platform.');
        await build(runtime, process.versions.node, abi, arch);
        const tarPath = 'prebuilds/' + pkg.name + '-v' + pkg.version + '-' + runtime + '-v' + abi + '-' + process.platform + '-' + arch + '.tar.gz';
        if (!fs.existsSync(path.dirname(tarPath))) {
          fs.mkdirSync(path.dirname(tarPath));
        }
        await tar.c(
          {
            gzip: true,
            file: path.resolve(os.tmpdir(), 'prebuild.tar.gz'),
            sync: true,
          },
          FILES_TO_ARCHIVE[process.platform],
        );
      }
      await fs.remove(path.join(__dirname, 'build'));
      await fs.remove(path.join(__dirname, 'prebuilds'));
    }

    let options = {
      readable: true,
      writable: true,
      hardlinkAsFilesFallback: true
    };

    let binaryName;
    let updateName = function(entry) {
      if (/\.node$/i.test(entry.name)) binaryName = entry.name
    };
    await fs.remove(path.join(__dirname, 'builds'));
    await fs.ensureDir(path.join(__dirname, 'builds'));
    let extract = tfs.extract(targetFile, options)
      .on('entry', updateName);
    pump(fs.createReadStream(path.join(nuggetOpts.dir, nuggetOpts.target)), zlib.createGunzip(), extract, function(err) {
      if (err) {
        return onerror(err);
      }
      cb()
    });
  });
}

const options = optionsFromPackage();
if (process.env.npm_config_targets) {
  options.targets = options.targets.concat(process.env.npm_config_targets.split(','));
}
options.targets = options.targets.map(targetStr => targetStr.split('-'));
if (process.env.npm_config_targets === 'all') {
  options.targets = supportedTargets.map(arr => [arr[0], arr[2]]);
  options.platforms = ['win32', 'darwin', 'linux'];
  options.arches = ['x64', 'ia32']
}
if (process.env.npm_config_platforms) {
  options.platforms = options.platforms.concat(process.env.npm_config_platforms.split(','));
}
if (process.env.npm_config_arches) {
  options.arches = options.arches.concat(process.env.npm_config_arches.split(','));
}

// Choice prebuilds for install
if (options.targets.length > 0) {
  let chain = Promise.resolve();
  options.targets.forEach(function(parts) {
    let runtime = parts[0];
    let abi = parts[1];
    options.platforms.forEach(function(platform) {
      options.arches.forEach(function(arch) {
        if (platform === 'darwin' && arch === 'ia32') {
          return;
        }
        chain = chain.then(function() {
          return new Promise(function(resolve) {
            console.log(runtime, abi, platform, arch);
            install(runtime, abi, platform, arch, resolve)
          })
        })
      })
    })
  })
} else {
  const isElectron = fs.existsSync(path.resolve(__dirname, '..', 'electron'));
  const runtime = isElectron ? 'electron' : 'node';
  const abi = isElectron ? nodeAbi.getAbi(require(path.resolve(__dirname, '..', 'electron', 'package.json')).version, 'electron') : process.versions.modules;
  const platform = process.platform;
  const arch = process.arch;
  install(runtime, abi, platform, arch, function() {
  })
}
