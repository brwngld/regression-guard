import type { ChangeContract } from './schema/contract'

/**
 * Reserved extension point (milestone 5).
 *
 * The engine is deterministic: every verdict above is derived from git facts,
 * the import graph, and the contract — never from an LLM. Advisors may only
 * *draft* inputs (contract inference, test ideas) for human approval; they
 * never replace deterministic verdicts. This keeps the verifier independent
 * from any change producer, including AI agents advised by the same models.
 */
export interface ContractAdvisor {
  /** Draft a change contract from a natural-language change request. */
  draftContract(request: string, context: { repoRoot: string }): Promise<ChangeContract>
}

/** Deterministic no-op advisor used until M5. */
export const nullAdvisor: ContractAdvisor = {
  async draftContract() {
    throw new Error('No contract advisor configured (LLM advisors arrive in milestone 5).')
  },
}
