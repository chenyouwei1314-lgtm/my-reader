const fs = require('fs');
const path = require('path');

// 取得專案根目錄
const rootDir = path.resolve(__dirname, '..');

// Forge package 產生的免安裝版 app 位置
const packagedAppDir = path.join(
  rootDir,
  'out',
  'AirWei Reader-win32-x64'
);

// thumbnail-provider 來源
const thumbnailProviderSource = path.join(
  rootDir,
  'extraResources',
  'thumbnail-provider'
);

// thumbnail-provider 目標位置
const thumbnailProviderTarget = path.join(
  packagedAppDir,
  'resources',
  'thumbnail-provider'
);

// launcher 來源
const launchersSource = path.join(
  rootDir,
  'extraResources',
  'launchers'
);

// launcher 目標位置：放在 app 根目錄
const launchersTarget = packagedAppDir;

// 複製整個資料夾
function copyDir(source, target) {
  if (!fs.existsSync(source)) {
    console.warn(`找不到資料夾，略過：${source}`);
    return;
  }

  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

// 複製 launcher exe / config
function copyLaunchers(source, target) {
  if (!fs.existsSync(source)) {
    console.warn(`找不到 launchers 資料夾，略過：${source}`);
    return;
  }

  fs.mkdirSync(target, { recursive: true });

  for (const fileName of fs.readdirSync(source)) {
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.exe' && ext !== '.config') {
      continue;
    }

    fs.copyFileSync(
      path.join(source, fileName),
      path.join(target, fileName)
    );
  }
}

// 確認 Forge package 已經成功產生 app
if (!fs.existsSync(packagedAppDir)) {
  throw new Error(`找不到 Forge package 輸出資料夾：${packagedAppDir}`);
}

// 複製 thumbnail-provider
copyDir(thumbnailProviderSource, thumbnailProviderTarget);

// 複製 PDF / CBZ launchers
copyLaunchers(launchersSource, launchersTarget);

console.log('dist 前置資源整理完成');