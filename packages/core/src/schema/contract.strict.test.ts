import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseContract, ContractValidationError } from './contract'

describe('strict contract schema (adversarial finding)', () => {
  it('rejects a path rule misplaced at the top level with pointed guidance', () => {
    // The exact authoring mistake found in adversarial verification:
    // `prohibited:` at column 0 instead of under `paths:` — previously parsed
    // as a VALID contract with zero prohibitions, silently weakening every
    // verdict computed under it. Declared-incorrectly must be an error.
    const misplaced = parseYaml(`version: 1
id: x
goal: g
paths:
  mustChange: ["public/**"]
prohibited:
  - category: dependency-addition
`)
    expect(() => parseContract(misplaced)).toThrow(ContractValidationError)
    expect(() => parseContract(misplaced)).toThrow("is a path rule and belongs under 'paths:'")
    expect(() => parseContract(misplaced)).toThrow(/prohibited/)
  })

  it('rejects any unknown top-level or paths-level key', () => {
    expect(() => parseContract(parseYaml('version: 1\nid: x\ngoal: g\ntotallyUnknown: 1'))).toThrow(
      /nrecognized/i,
    )
    expect(() =>
      parseContract(parseYaml('version: 1\nid: x\ngoal: g\npaths:\n  mustChange: []\n  forbid: []')),
    ).toThrow(/nrecognized/i)
  })

  it('still accepts a correctly formed contract unchanged', () => {
    const contract = parseContract(
      parseYaml(`version: 1
id: x
goal: g
paths:
  mustChange: ["a/**"]
  prohibited:
    - category: dependency-addition
`),
    )
    expect(contract.paths.prohibited).toEqual([{ category: 'dependency-addition' }])
  })
})
