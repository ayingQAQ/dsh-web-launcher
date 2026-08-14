import { readFile, writeFile } from 'node:fs/promises'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  throw new Error('Usage: node scripts/png-to-ico.mjs <input.png> <output.ico>')
}

const png = await readFile(input)
if (png.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) {
  throw new Error('Input must be a PNG file.')
}

// ICO supports PNG payloads directly. One 256px image gives Windows a crisp
// icon at every normal shortcut size without depending on an icon converter.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // 256 px is represented as 0 in ICO.
entry[1] = 0
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(header.length + entry.length, 12)
await writeFile(output, Buffer.concat([header, entry, png]))
