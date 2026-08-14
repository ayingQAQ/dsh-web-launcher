#!/usr/bin/env node
import { reportCliError, runCli } from '../src/index.js'

runCli().catch(reportCliError)
