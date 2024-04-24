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
    const apiOptions = {
      owner: github.context.payload.organization.login,
      repo: `${github.context.payload.repository?.name}`,
      run_id: github.context.runId,
      Headers: {
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json'
      }
    }
    core.info(JSON.stringify(apiOptions))
    core.info(
      JSON.stringify(await octokit.rest.actions.getWorkflowRun(apiOptions))
    )
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
