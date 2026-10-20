#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceName = ['AGENTS', 'md'].join('.')
const entryName = `${['CLAU', 'DE'].join('')}.${'md'}`
const sourcePath = join(root, sourceName)
const entryPath = join(root, entryName)
const stat = (path) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const sourceStat = stat(sourcePath)
const entryStat = stat(entryPath)
const sourceExists = sourceStat !== null
const entryExists = entryStat !== null

if (!sourceExists && !entryExists) {
  console.log('rules: public snapshot has no agent entry points')
  process.exit(0)
}

if (sourceExists !== entryExists)
  throw new Error(
    'rules: the canonical rule body and its paired entry point must be present together',
  )

if (
  !sourceStat.isFile() ||
  sourceStat.isSymbolicLink() ||
  !entryStat.isFile() ||
  entryStat.isSymbolicLink()
)
  throw new Error('rules: both rule entry points must be regular files')

const entry = readFileSync(entryPath, 'utf8').replaceAll('\r\n', '\n')
const expected = `@${sourceName}`
if (entry !== `${expected}\n`)
  throw new Error(
    'rules: the paired entry point must import the canonical rule body without extra text',
  )

if (!readFileSync(sourcePath, 'utf8').trim())
  throw new Error('rules: the canonical rule body is empty')

console.log('rules: canonical body and paired entry point are synchronized')
