import * as jsyaml from 'js-yaml'
import picomatch from 'picomatch'
import * as core from '@actions/core'
import {File, ChangeStatus} from './file'

// Type definition of object we expect to load from YAML
interface FilterYaml {
  [name: string]: FilterItemYaml
}
type FilterItemYaml =
  | string // Filename pattern, e.g. "path/to/*.js"
  | {[changeTypes: string]: string | string[]} // Change status and filename, e.g. added|modified: "path/to/*.js"
  | FilterItemYaml[] // Supports referencing another rule via YAML anchor

// Minimatch options used in all matchers
const MatchOptions = {
  dot: true
}

// Internal representation of one item in named filter rule
// Created as simplified form of data in FilterItemYaml
interface FilterRuleItem {
  status?: ChangeStatus[] // Required change status of the matched files
  isMatch: (str: string) => boolean // Matches the filename
  exclude: boolean
  isExcluded?: (str: string) => boolean
  pattern: string
}

/**
 * Enumerates the possible logic quantifiers that can be used when determining
 * if a file is a match or not with multiple patterns.
 *
 * The YAML configuration property that is parsed into one of these values is
 * 'predicate-quantifier' on the top level of the configuration object of the
 * action.
 *
 * The default is to use 'some' which used to be the hardcoded behavior prior to
 * the introduction of the new mechanism.
 *
 * @see https://en.wikipedia.org/wiki/Quantifier_(logic)
 */
export enum PredicateQuantifier {
  /**
   * When choosing 'every' in the config it means that files will only get matched
   * if all the patterns are satisfied by the path of the file, not just at least one of them.
   */
  EVERY = 'every',
  /**
   * When choosing 'some' in the config it means that files will get matched as long as there is
   * at least one pattern that matches them. This is the default behavior if you don't
   * specify anything as a predicate quantifier.
   */
  SOME = 'some'
}

/**
 * Used to define customizations for how the file filtering should work at runtime.
 */
export type FilterConfig = {readonly predicateQuantifier: PredicateQuantifier}

/**
 * An array of strings (at runtime) that contains the valid/accepted values for
 * the configuration parameter 'predicate-quantifier'.
 */
export const SUPPORTED_PREDICATE_QUANTIFIERS = Object.values(PredicateQuantifier)

export function isPredicateQuantifier(x: unknown): x is PredicateQuantifier {
  return SUPPORTED_PREDICATE_QUANTIFIERS.includes(x as PredicateQuantifier)
}

export interface FilterResults {
  [key: string]: File[]
}

export class Filter {
  rules: {[key: string]: FilterRuleItem[]} = {}

  // Creates instance of Filter and load rules from YAML if it's provided
  constructor(yaml?: string, readonly filterConfig?: FilterConfig) {
    if (yaml) {
      this.load(yaml)
    }
  }

  // Load rules from YAML string
  load(yaml: string): void {
    if (!yaml) {
      return
    }

    const doc = jsyaml.load(yaml) as FilterYaml
    if (typeof doc !== 'object') {
      this.throwInvalidFormatError('Root element is not an object')
    }

    for (const [key, item] of Object.entries(doc)) {
      this.rules[key] = this.parseFilterItemYaml(item)
    }
  }

  match(files: File[]): FilterResults {
    const result: FilterResults = {}
    core.startGroup('Filter Evaluation Details')
    
    for (const [key, rules] of Object.entries(this.rules)) {
      core.info('')
      core.info(`Evaluating filter: ${key}`)
      core.info(`   Patterns (${rules.length}):`)
      for (const rule of rules) {
        const prefix = rule.exclude ? '  - EXCLUDE' : '  + INCLUDE'
        const statusPart = rule.status ? ` [${rule.status.join('|')}]` : ''
        core.info(`   ${prefix}: ${rule.pattern}${statusPart}`)
      }
      core.info('')
      
      result[key] = files.filter(file => {
        const matched = this.isMatch(file, rules, key)
        return matched
      })
      
      core.info(`   >> Result: ${result[key].length} files matched`)
      core.info('')
    }
    
    core.endGroup()
    return result
  }

  private isMatch(file: File, patterns: FilterRuleItem[], filterName?: string): boolean {
    const logDetail = (msg: string): void => {
      core.info(`      ${msg}`)
    }
    
    core.info(`   File: ${file.filename} [${file.status}]`)
    
    const matchesRule = (rule: Readonly<FilterRuleItem>): boolean => {
      if (rule.status !== undefined && !rule.status.includes(file.status)) {
        logDetail(`   - Pattern "${rule.pattern}" - status mismatch (needs ${rule.status.join('|')})`)
        return false
      }
      const patternMatches = rule.isMatch(file.filename)
      if (!rule.exclude) {
        if (patternMatches) {
          logDetail(`   + Pattern "${rule.pattern}" - MATCH`)
        } else {
          logDetail(`   - Pattern "${rule.pattern}" - no match`)
        }
      }
      return patternMatches
    }

    const isExcluded = (rule: Readonly<FilterRuleItem>): boolean => {
      if (!rule.exclude || rule.isExcluded === undefined) {
        return false
      }
      if (rule.status !== undefined && !rule.status.includes(file.status)) {
        return false
      }
      const excluded = rule.isExcluded(file.filename)
      if (excluded) {
        logDetail(`   X EXCLUDED by "${rule.pattern}"`)
      }
      return excluded
    }

    const hasPositiveMatch = patterns.some(rule => !rule.exclude && matchesRule(rule))
    const matchingPositiveRules = patterns.filter(rule => !rule.exclude && matchesRule(rule))
    const hasLiteralPositiveMatch = matchingPositiveRules.some(rule => isLiteralPattern(rule.pattern))
    const hasExcludeMatch = patterns.some(isExcluded)

    let finalResult = false
    let reason = ''

    if (hasExcludeMatch && (!hasPositiveMatch || !hasLiteralPositiveMatch)) {
      finalResult = false
      reason = hasPositiveMatch 
        ? 'excluded (matched exclusion pattern without literal positive match)'
        : 'excluded (matched exclusion pattern)'
    } else if (this.filterConfig?.predicateQuantifier === 'every') {
      finalResult = patterns.every(matchesRule)
      reason = finalResult ? 'matched (all patterns)' : 'not matched (not all patterns matched)'
    } else {
      finalResult = patterns.some(matchesRule)
      reason = finalResult ? 'matched' : 'not matched (no patterns matched)'
    }

    const icon = finalResult ? '[MATCH]' : '[NO MATCH]'
    core.info(`      ${icon} Final: ${reason}`)

    return finalResult
  }

  private parseFilterItemYaml(item: FilterItemYaml): FilterRuleItem[] {
    if (Array.isArray(item)) {
      return flat(item.map(i => this.parseFilterItemYaml(i)))
    }

    if (typeof item === 'string') {
      return [this.createRule(item)]
    }

    if (typeof item === 'object') {
      return flat(
        Object.entries(item).map(([key, pattern]) => {
          if (typeof key !== 'string' || (typeof pattern !== 'string' && !Array.isArray(pattern))) {
            this.throwInvalidFormatError(
              `Expected [key:string]= pattern:string | string[], but [${key}:${typeof key}]= ${pattern}:${typeof pattern} found`
            )
          }

          const statuses = key
            .split('|')
            .map(x => x.trim())
            .filter(x => x.length > 0)
            .map(x => x.toLowerCase()) as ChangeStatus[]

          const patterns = Array.isArray(pattern) ? pattern : [pattern]
          return patterns.map(p => this.createRule(p, statuses))
        })
      )
    }

    this.throwInvalidFormatError(`Unexpected element type '${typeof item}'`)
  }

  private createRule(pattern: string, status?: ChangeStatus[]): FilterRuleItem {
    const {matcherPattern, exclude, excludedPattern} = analyzePattern(pattern)
    const normalizedStatus = status && status.length > 0 ? [...status] : undefined
    return {
      status: normalizedStatus,
      exclude,
      isMatch: picomatch(matcherPattern, MatchOptions),
      isExcluded: excludedPattern ? picomatch(excludedPattern, MatchOptions) : undefined,
      pattern
    }
  }

  private throwInvalidFormatError(message: string): never {
    throw new Error(`Invalid filter YAML format: ${message}.`)
  }
}

function analyzePattern(pattern: string): {
  matcherPattern: string
  exclude: boolean
  excludedPattern?: string
} {
  const isExtglobNegation = pattern.startsWith('!(')
  const isBraceExpansion = pattern.startsWith('!{')
  const isCharacterClass = pattern.startsWith('![')

  if (pattern.startsWith('!') && !isExtglobNegation && !isBraceExpansion && !isCharacterClass) {
    const positivePattern = pattern.slice(1)
    return {
      matcherPattern: pattern,
      exclude: true,
      excludedPattern: positivePattern.length > 0 ? positivePattern : undefined
    }
  }

  return {matcherPattern: pattern, exclude: false}
}

function isLiteralPattern(pattern: string): boolean {
  return !/[?*+@!\[\]{},()]/.test(pattern)
}

// Creates a new array with all sub-array elements concatenated
// In future could be replaced by Array.prototype.flat (supported on Node.js 11+)
function flat<T>(arr: T[][]): T[] {
  return arr.reduce((acc, val) => acc.concat(val), [])
}
