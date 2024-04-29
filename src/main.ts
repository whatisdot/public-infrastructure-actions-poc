import * as core from '@actions/core'
import * as github from '@actions/github'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const runner = new Consolidator()
    await runner.otherStuff()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/**
 * Consolidate the output of all jobs that came prior to this job and return as the output of this job.
 */
class Consolidator {
  octokit: any

  constructor() {
    this.octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
  }

  async otherStuff() {
    core.info('Context:')
    core.info(JSON.stringify(github.context))
    core.info(`Jobs for Workflow Run Number ${github.context.runId}`)
    const apiOptions = {
      owner: github.context.payload.organization.login,
      repo: `${github.context.payload.repository?.name}`,
      run_id: github.context.runId
    }
    core.info(JSON.stringify(apiOptions))
    const jobInfo =
      await this.octokit.rest.actions.listJobsForWorkflowRun(apiOptions)
    core.info(JSON.stringify(jobInfo))
    const jobDetails = await this.octokit.rest.actions.getJobForWorkflowRun({
      owner: apiOptions.owner,
      repo: apiOptions.repo,
      job_id: jobInfo.data.jobs[3].id
    })
    core.info(JSON.stringify(jobDetails))
  }

  /**
   * Get the GitHub Action Workflow schema for the currently running job. This will query for the
   * YAML file of the current branch and return a data structure.
   */
  async getWorkflowSchema() {}

  /**
   * Identify the job definition(s) that this job relies upon (what it specified as "needs").
   */
  async getPreviousJobDefinition() {
    // use details in current `github.context`
    // grab workflow data structure from Action (YAML to JSON to object)
  }

  /**
   * Get the job details for any job that ran with that same definition.
   *
   * @param definitionId
   */
  async getJobDetails(definitionId: string) {}

  /**
   * Gather the outputs for the job runs and put them into an array.
   */
  async getJobOutputs(jobRunIds: Array<string>) {}

  /**
   * Return the array as outputs for this job.
   */
  defineActionOutputs() {}
}
