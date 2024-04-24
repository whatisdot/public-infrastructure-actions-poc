import * as core from '@actions/core'
import * as github from '@actions/github'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
    core.info(`Workflow Run Number ${github.context.runId}`)
    core.info(JSON.stringify(octokit.rest.actions.getWorkflowRun()))
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
