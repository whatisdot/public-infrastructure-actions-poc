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

  constructor() {
    this.octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
    this.context = github.context
    core.info('Context:')
    core.info(JSON.stringify(this.context))
    throw new Error(
      'Intentionally fail while testing to make it faster to rerun jobs.'
    )
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
    const workflowJobs = await this.getWorkflowJobs()
    const jobDetails = neededJobConfigs
      .map((config: any) =>
        workflowJobs.filter(job => {
          return job.name.startsWith(config.name)
        })
      )
      .flat()
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
    const response: any = await this.octokit.rest.repos.getContent({
      ...this.commonQueryParams(),
      path: this.context.payload.workflow,
      ref: this.context.payload.ref
    })
    const schema = YAML.parse(
      Buffer.from(response.data.content, 'base64').toString('utf8')
    )
    core.info('Workflow Schema:')
    core.info(JSON.stringify(schema))

    return schema
  }

  /**
   * Get the job details for any job that ran with that same definition.
   */
  async getJobDetails(jobName: string) {
    const workflowJobs = await this.getWorkflowJobs()
    return workflowJobs.filter((job: any) => job.name.startsWith(jobName))
  }

  /**
   * Get all jobs running within this workflow.
   */
  async getWorkflowJobs() {
    const workflowJobs = await this.octokit.rest.actions.listJobsForWorkflowRun(
      {
        ...this.commonQueryParams(),
        run_id: this.context.runId
      }
    )
    core.info(`listJobsForWorkflowRun`)
    core.info(JSON.stringify(workflowJobs))

    return workflowJobs.data.jobs
  }

  /**
   * Gather the outputs for the job runs and put them into an array.
   */
  async getJobOutputs(jobDetails: Array<any>) {
    core.info('JOB DETAILS')
    core.info(JSON.stringify(jobDetails))
    const jobArtifacts = await this.getRunArtifacts()
    jobDetails
      .map(j => j.id.toString())
      .map(jobId => {
        // get any artifacts with a name that matches the job id
        const artifact = jobArtifacts.data.artifacts.find(a => a.name == jobId)
        if (artifact) core.info(`Found Artifact for ${jobId}, ${artifact.id}`)
        // download the artifact as a temp file and decompress it
        // load the file as JSON
        // return the data structure as an array of objects
        return {}
      })
  }

  /**
   * Get all artifacts associated with this run.
   */
  async getRunArtifacts() {
    const response = await this.octokit.rest.actions.listWorkflowRunArtifacts({
      ...this.commonQueryParams(),
      run_id: this.context.runId
    })
    core.info('listWorkflowRunArtifacts')
    core.info(JSON.stringify(response))

    return response
  }

  /**
   * Return the array as outputs for this job.
   */
  defineActionOutputs() {}
}
