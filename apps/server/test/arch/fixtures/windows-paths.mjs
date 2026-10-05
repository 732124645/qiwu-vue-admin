// Simulate Windows glob results before the real architecture runner imports Node's builtins.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

const globSync = fs.globSync
fs.globSync = (...args) => globSync(...args).map((file) => file.split('/').join('\\'))
path.sep = '\\'
syncBuiltinESMExports()
