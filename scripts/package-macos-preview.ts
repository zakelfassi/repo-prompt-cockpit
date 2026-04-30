import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  name: string;
  productName?: string;
  version: string;
  description?: string;
  license?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(repoRoot, 'package.json');
const packageMetadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageMetadata;
const appName = packageMetadata.productName ?? 'Repo Prompt Cockpit';
const bundleIdentifier = 'com.repoprompt.cockpit';
const currentArch = arch();
const artifactArch = currentArch === 'x64' ? 'x64' : currentArch === 'arm64' ? 'arm64' : currentArch;
const releaseRoot = join(repoRoot, 'release');
const workRoot = join(releaseRoot, 'mac-preview');
const appPath = join(workRoot, `${appName}.app`);
const dmgRoot = join(workRoot, 'dmg-root');
const electronAppPath = join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');
const appResourcesPath = join(appPath, 'Contents', 'Resources', 'app');
const appExecutablePath = join(appPath, 'Contents', 'MacOS', appName);
const defaultElectronExecutablePath = join(appPath, 'Contents', 'MacOS', 'Electron');
const bundleIconFile = 'repoprompt-cockpit.icns';
const logoPngPath = join(repoRoot, 'src', 'renderer', 'assets', 'repoprompt-cockpit-logo.png');
const bundleIconPath = join(appPath, 'Contents', 'Resources', bundleIconFile);
const iconsetPath = join(workRoot, 'repoprompt-cockpit.iconset');
const version = packageMetadata.version;
const zipPath = join(releaseRoot, `${appName}-${version}-mac-${artifactArch}.zip`);
const dmgPath = join(releaseRoot, `${appName}-${version}-mac-${artifactArch}.dmg`);
const args = new Set(process.argv.slice(2));
const shouldZip = !args.has('--skip-zip');
const shouldDmg = args.has('--dmg') && !args.has('--skip-dmg');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(command: string, commandArgs: string[]): void {
  execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
}

function copyIntoApp(relativePath: string): void {
  const source = join(repoRoot, relativePath);
  const destination = join(appResourcesPath, relativePath);

  if (!existsSync(source)) fail(`Expected build input is missing: ${relativePath}`);
  mkdirSync(join(destination, '..'), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function replacePlistValue(plist: string, key: string, value: string): string {
  const escapedValue = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const keyPattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);

  if (keyPattern.test(plist)) {
    return plist.replace(keyPattern, `$1${escapedValue}$3`);
  }

  return plist.replace('</dict>', `  <key>${key}</key>\n  <string>${escapedValue}</string>\n</dict>`);
}

function updateInfoPlist(): void {
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist');
  let plist = readFileSync(infoPlistPath, 'utf8');

  const replacements: Record<string, string> = {
    CFBundleDisplayName: appName,
    CFBundleExecutable: appName,
    CFBundleIconFile: bundleIconFile,
    CFBundleIdentifier: bundleIdentifier,
    CFBundleName: appName,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    NSHumanReadableCopyright: `${appName} preview build`,
  };

  for (const [key, value] of Object.entries(replacements)) {
    plist = replacePlistValue(plist, key, value);
  }

  writeFileSync(infoPlistPath, plist);
}

function writeBundleIcon(): void {
  if (!existsSync(logoPngPath)) fail(`Expected app icon source is missing: ${logoPngPath}`);
  rmSync(iconsetPath, { recursive: true, force: true });
  mkdirSync(iconsetPath, { recursive: true });

  const iconFiles: Array<{ size: number; scale: 1 | 2; filename: string }> = [
    { size: 16, scale: 1, filename: 'icon_16x16.png' },
    { size: 16, scale: 2, filename: 'icon_16x16@2x.png' },
    { size: 32, scale: 1, filename: 'icon_32x32.png' },
    { size: 32, scale: 2, filename: 'icon_32x32@2x.png' },
    { size: 128, scale: 1, filename: 'icon_128x128.png' },
    { size: 128, scale: 2, filename: 'icon_128x128@2x.png' },
    { size: 256, scale: 1, filename: 'icon_256x256.png' },
    { size: 256, scale: 2, filename: 'icon_256x256@2x.png' },
    { size: 512, scale: 1, filename: 'icon_512x512.png' },
    { size: 512, scale: 2, filename: 'icon_512x512@2x.png' }
  ];

  for (const iconFile of iconFiles) {
    const pixels = String(iconFile.size * iconFile.scale);
    run('sips', ['-z', pixels, pixels, logoPngPath, '--out', join(iconsetPath, iconFile.filename)]);
  }

  run('iconutil', ['-c', 'icns', iconsetPath, '-o', bundleIconPath]);
  rmSync(iconsetPath, { recursive: true, force: true });
  rmSync(join(appPath, 'Contents', 'Resources', 'electron.icns'), { force: true });
}

function writeRuntimePackageJson(): void {
  const runtimePackageJson = {
    name: packageMetadata.name,
    productName: appName,
    version,
    private: true,
    license: packageMetadata.license,
    description: packageMetadata.description,
    main: 'electron-main.cjs',
    type: 'module',
  };

  writeFileSync(join(appResourcesPath, 'package.json'), `${JSON.stringify(runtimePackageJson, null, 2)}\n`);
}

if (platform() !== 'darwin') {
  fail('macOS preview packaging must be run on macOS because it uses Electron.app, ditto, and hdiutil.');
}

if (!existsSync(electronAppPath) || !existsSync(tscPath)) {
  fail('Build dependencies are missing. Run `pnpm install` before `pnpm package:mac`.');
}

rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });
run(tscPath, ['-p', 'tsconfig.json']);

rmSync(workRoot, { recursive: true, force: true });
rmSync(zipPath, { force: true });
rmSync(dmgPath, { force: true });
mkdirSync(workRoot, { recursive: true });
mkdirSync(releaseRoot, { recursive: true });

cpSync(electronAppPath, appPath, { recursive: true, verbatimSymlinks: true });
rmSync(join(appPath, 'Contents', 'Resources', 'default_app.asar'), { force: true });
rmSync(join(appPath, 'Contents', 'Resources', 'default_app.asar.unpacked'), { recursive: true, force: true });

if (existsSync(defaultElectronExecutablePath)) {
  rmSync(appExecutablePath, { force: true });
  cpSync(defaultElectronExecutablePath, appExecutablePath);
  rmSync(defaultElectronExecutablePath, { force: true });
}

updateInfoPlist();
writeBundleIcon();
mkdirSync(appResourcesPath, { recursive: true });
copyIntoApp('electron-main.cjs');
copyIntoApp('dist/src');
copyIntoApp('src/renderer/index.html');
copyIntoApp('src/renderer/styles.css');
copyIntoApp('src/renderer/assets');
copyIntoApp('LICENSE');
writeRuntimePackageJson();

function adhocSignBundle(): void {
  const frameworksDir = join(appPath, 'Contents', 'Frameworks');
  const entries = readdirSync(frameworksDir);
  const helpers = entries
    .filter((entry) => entry.endsWith('.app'))
    .map((entry) => join(frameworksDir, entry));
  const frameworks = entries
    .filter((entry) => entry.endsWith('.framework'))
    .map((entry) => join(frameworksDir, entry));
  for (const helper of helpers) run('codesign', ['--force', '--sign', '-', helper]);
  for (const framework of frameworks) run('codesign', ['--force', '--sign', '-', framework]);
  run('codesign', ['--force', '--sign', '-', appPath]);
}

adhocSignBundle();

if (shouldZip) {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);
}

if (shouldDmg) {
  mkdirSync(dmgRoot, { recursive: true });
  cpSync(appPath, join(dmgRoot, basename(appPath)), { recursive: true });
  run('hdiutil', ['create', '-volname', appName, '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmgPath]);
}

console.log(`Packaged ${appName} ${version} for macOS ${artifactArch}:`);
console.log(`- ${appPath}`);
if (shouldZip) console.log(`- ${zipPath}`);
if (shouldDmg) console.log(`- ${dmgPath}`);
if (!shouldDmg) console.log('DMG creation skipped by default; run `pnpm package:mac:dmg` on macOS if a disk image is needed.');
console.log('Signing and notarization are intentionally not performed for this private preview build.');
