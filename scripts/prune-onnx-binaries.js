/**
 * Runs on Heroku after the build (see "heroku-postbuild" in package.json).
 *
 * `onnxruntime-node`, which the receipt OCR runs on, ships native binaries
 * for every platform in one package: Windows, macOS and Linux for x64 and
 * arm64, roughly 300 MB in all. A dyno needs exactly one of them, and the
 * slug has a size limit, so the rest are deleted.
 *
 * Only ever acts on Linux, so running it on a developer's machine — where
 * their own platform's binary is the one that matters — does nothing.
 */
const fs = require('fs');
const path = require('path');

if (process.platform !== 'linux') {
  console.log('prune-onnx-binaries: not Linux, leaving the binaries alone.');
  process.exit(0);
}

const root = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin');
if (!fs.existsSync(root)) {
  console.log('prune-onnx-binaries: onnxruntime-node binaries not found, nothing to prune.');
  process.exit(0);
}

let freed = 0;
const sizeOf = target => {
  const stat = fs.statSync(target);
  return stat.isDirectory()
    ? fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0)
    : stat.size;
};

for (const napi of fs.readdirSync(root)) {
  for (const platform of fs.readdirSync(path.join(root, napi))) {
    for (const arch of fs.readdirSync(path.join(root, napi, platform))) {
      if (platform === 'linux' && arch === process.arch) {
        continue;
      }
      const dir = path.join(root, napi, platform, arch);
      freed += sizeOf(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
console.log('prune-onnx-binaries: removed ' + Math.round(freed / 1048576) + ' MB of other platforms.');
