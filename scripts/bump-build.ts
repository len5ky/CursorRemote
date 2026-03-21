import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const PKG_PATH = resolve(process.cwd(), 'package.json');

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

pkg.version = newVersion;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

console.log(`[bump-build] ${major}.${minor}.${patch} → ${newVersion}`);
