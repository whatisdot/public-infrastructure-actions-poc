import * as core from '@actions/core'
import * as github from '@actions/github'
import YAML from 'yaml'
import { Context } from '@actions/github/lib/context'
import { Octokit } from '@octokit/core'
import { PaginateInterface } from '@octokit/plugin-paginate-rest'
import { Api } from '@octokit/plugin-rest-endpoint-methods/dist-types/types'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const runner = new Consolidator()
    await runner.run()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/**
 * Consolidate the output of all jobs that came prior to this job and return as the output of this job.
 */
class Consolidator {
  octokit: Octokit & Api & { paginate: PaginateInterface }
  context: Context
  _schema: any
  _workflowJobs: any

  constructor() {
    this.octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
    this.context = github.context
    core.debug('Context:')
    core.debug(JSON.stringify(this.context))
    // core.getInput()
  }

  commonQueryParams() {
    return {
      owner: this.context.payload.organization.login,
      repo: `${this.context.payload.repository?.name}`
    }
  }

  async run() {
    const neededJobConfigs = await this.getJobsNeededByThisJob()
    const jobDetails = neededJobConfigs
      .map(async (config: any) => await this.getJobDetails(config.name))
      .flatten()
    const jobOutputs = this.getJobOutputs(jobDetails)
  }

  /**
   * Identify the job definition(s) that this job relies upon (what it specified as "needs").
   */
  async getJobsNeededByThisJob() {
    const schema = await this.getWorkflowSchema()
    const priorJobNames = schema.jobs[this.context.job].needs
    return priorJobNames.map((jobName: any) => schema.jobs[jobName])
  }

  /**
   * Get the GitHub Action Workflow schema for the currently running job. This will query for the
   * YAML file of the current branch and return a data structure.
   */
  async getWorkflowSchema() {
    if (this._schema) return this._schema

    const response: any = await this.octokit.rest.repos.getContent({
      ...this.commonQueryParams(),
      path: this.context.payload.workflow,
      ref: this.context.payload.ref
    })
    this._schema = YAML.parse(
      Buffer.from(response.data.content, 'base64').toString('utf8')
    )
    core.debug('Workflow Schema:')
    core.debug(JSON.stringify(this._schema))

    return this._schema
  }

  /**
   * Get the job details for any job that ran with that same definition.
   */
  async getJobDetails(jobName: string) {
    const workflowJobs: any = this.getWorkflowJobs()
    return workflowJobs.data.jobs.filter((job: any) =>
      job.name.startsWith(jobName)
    )
  }

  /**
   * Get all jobs running within this workflow.
   */
  async getWorkflowJobs() {
    if (this._workflowJobs) return this._workflowJobs

    this._workflowJobs = await this.octokit.rest.actions.listJobsForWorkflowRun(
      {
        ...this.commonQueryParams(),
        run_id: this.context.runId
      }
    )
    core.debug(`listJobsForWorkflowRun`)
    core.debug(JSON.stringify(this._workflowJobs))

    return this._workflowJobs
  }

  /**
   * Gather the outputs for the job runs and put them into an array.
   */
  async getJobOutputs(jobDetails: Array<any>) {
    const response = await this.octokit.rest.actions.listWorkflowRunArtifacts({
      ...this.commonQueryParams(),
      run_id: this.context.runId
    })
    const jobArtifacts = response.data.artifacts
    jobDetails.map(job => {
      // get any artifacts with a name that matches the job id
      const artifact = jobArtifacts.find(artifact => artifact.name == job.id)
      if (artifact) core.debug(`Found Artifact for ${job.id}`)
      // download the artifact as a temp file and decompress it
      // load the file as JSON
      // return the data structure as an array of objects
      return {}
    })
  }

  /**
   * Return the array as outputs for this job.
   */
  defineActionOutputs() {}
}
