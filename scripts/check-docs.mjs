import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function validateDoc(file, bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/\uFFFD|[\uE000-\uF8FF]|\u7ee0\u20ac|\u935a\u5c7e|\u9286\u4e63|\u951b\u5c7e|\u9225\?/.test(text)) {
    throw new Error(`${file}: corrupted text detected; restore the original UTF-8 content`)
  }
  const link = file === 'README.md'
    ? '[\u7b80\u4f53\u4e2d\u6587](README.zh-CN.md)'
    : '[English](README.md) | \u7b80\u4f53\u4e2d\u6587'
  if (!text.split(/\r?\n/).slice(0, 10).join('\n').includes(link)) {
    throw new Error(`${file}: language navigation is missing or corrupted`)
  }
  if ((text.match(/^```/gm) || []).length % 2) throw new Error(`${file}: unclosed code fence`)
  if (file === 'README.zh-CN.md') {
    for (const heading of ['## \u5b89\u88c5\u4e0e\u751f\u6548', '## \u540c\u6b65\u884c\u4e3a', '## \u9a8c\u8bc1']) {
      if (!text.includes(heading)) throw new Error(`${file}: missing or corrupted heading`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['README.md', 'README.zh-CN.md']) validateDoc(file, fs.readFileSync(path.join(root, file)))
  console.log('README UTF-8 content, language links, and code fences verified.')
}
