import * as core from '@actions/core'
import * as github from '@actions/github'
import YAML from 'yaml'
import { Context } from '@actions/github/lib/context'
import { Octokit } from '@octokit/core'
import { PaginateInterface } from '@octokit/plugin-paginate-rest'
import { Api } from '@octokit/plugin-rest-endpoint-methods/dist-types/types'

interface JobInfo {
  id: number
  run_id: number
  run_url: string
  run_attempt?: number | undefined
  node_id: string
  head_sha: string
  url: string
  html_url: string | null
  status: 'queued' | 'in_progress' | 'completed' | 'waiting'
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null
  created_at: string
  started_at: string
  completed_at: string | null
  name: string
  steps?:
    | {
        status: 'queued' | 'in_progress' | 'completed'
        conclusion: string | null
        name: string
        number: number
        started_at?: string | null | undefined
        completed_at?:
          | string // Fail the workflow run if an error occurs
          // Fail the workflow run if an error occurs
          | null
          | undefined
      }[]
    | undefined
  check_run_url: string
  labels: string[]
  runner_id: number | null
  runner_name: /**
   * Consolidate the output of all jobs that came prior to this job and return as the output of this job.
   */ string | null
  runner_group_id: number | null
  runner_group_name: string | null
  workflow_name: string | null
  head_branch: string | null
}

interface Artifact {
  id: number
  node_id: string
  name: string
  size_in_bytes: number
  url: string
  archive_download_url: string
  expired: boolean
  created_at: string | null
  expires_at: string | null
  updated_at: string | null
  workflow_run?:
    | {
        id?: number | undefined
        repository_id?: number | undefined
        head_repository_id?: number | undefined
        head_branch?: string | undefined
        head_sha?: string | undefined
      }
    | null
    | undefined
}

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
  artifacts: Artifact[]
  workflowJobs: JobInfo[]
  schema: any

  constructor() {
    this.artifacts = []
    this.workflowJobs = []
    this.octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
    this.context = github.context
    core.info('Context:')
    core.info(JSON.stringify(this.context))
    // core.getInput()
  }

  commonQueryParams() {
    return {
      owner: this.context.payload.organization.login,
      repo: `${this.context.payload.repository?.name}`
    }
  }

  async run() {
    // Run async HTTP operations and cache results.
    this.schema = await this.getWorkflowSchema()
    this.artifacts = await this.getRunArtifacts()
    let currentWorkflowJobs: JobInfo[] = await this.getRelevantWorkflowJobs(
      this.context.runId
    )
    this.workflowJobs = await this.getLastRanWorkflowJobs(currentWorkflowJobs)
    core.info('Workflow Jobs')
    core.info(JSON.stringify(this.workflowJobs))
    const jobOutputs = this.getJobOutputs(this.workflowJobs)

    throw new Error(
      'Intentionally fail while testing to make it faster to rerun jobs.'
    )
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
   * Get jobs running within this workflow that are immediately preceding on this job, and have this
   * job as a dependent. If a workflow has been reran, this will iteratively query previous runs
   * until it can identify the job details that generated Artifacts.
   */
  async getLastRanWorkflowJobs(workflowJobs: JobInfo[]): Promise<JobInfo[]> {
    if (workflowJobs.length == 0) return []

    // runAttempt should be the same across jobs
    const runAttempt =
      (workflowJobs.find(job => job['run_attempt']) || {})['run_attempt'] || 1

    let jobsToReturn = workflowJobs.filter(job => job.runner_id != 0) || []
    let jobsToRerun =
      workflowJobs.filter(
        job => job.runner_id == 0 && (job['run_attempt'] || 1) > 1
      ) || []

    // return the relevant jobs immediately to avoid unneeded queries
    if (jobsToRerun.length == 0 || !(runAttempt > 1)) return jobsToReturn

    // save the job names to filter by later
    const reranJobNames = jobsToRerun.map(job => job.name)
    // query for the relevent jobs again, but from the previous run attempt
    let moreJobs: JobInfo[] = await this.getRelevantWorkflowJobs(
      this.context.runId,
      runAttempt - 1
    )
    // filter out the jobs that don't have the same name as the relevent ones from this run
    moreJobs = moreJobs.filter(job => reranJobNames.includes(job.name))
    // return the jobs to return while recursing in case we need to look back farther in the run attempts
    return jobsToReturn.concat(await this.getLastRanWorkflowJobs(moreJobs))
  }

  /**
   * Query for and filter jobs only relevent for the dependency relation.
   */
  async getRelevantWorkflowJobs(
    runId: number,
    runAttempt: number | null = null
  ): Promise<JobInfo[]> {
    let workflowJobs = await this.getWorkflowJobs(runId, runAttempt)
    return this.filterForRelevantJobDetails(workflowJobs)
  }

  /**
   * Get all jobs running within this workflow. An optional attempt number can be passed.
   */
  async getWorkflowJobs(run_id: number, attempt_number: number | null = null) {
    let workflowJobs = null

    if (attempt_number) {
      workflowJobs =
        await this.octokit.rest.actions.listJobsForWorkflowRunAttempt({
          ...this.commonQueryParams(),
          run_id,
          attempt_number
        })
    } else {
      workflowJobs = await this.octokit.rest.actions.listJobsForWorkflowRun({
        ...this.commonQueryParams(),
        run_id
      })
    }

    core.info('getWorkflowJobs:')
    core.info(JSON.stringify(workflowJobs))

    return workflowJobs.data.jobs
  }

  /**
   * Get all artifacts associated with this run.
   */
  async getRunArtifacts(): Promise<Artifact[]> {
    const response = await this.octokit.rest.actions.listWorkflowRunArtifacts({
      ...this.commonQueryParams(),
      run_id: this.context.runId
    })
    core.info('listWorkflowRunArtifacts')
    core.info(JSON.stringify(response))

    return response.data.artifacts
  }

  /**
   * Get the job details for any job that ran with that same definition.
   */
  filterForRelevantJobDetails(workflowJobs: JobInfo[]): JobInfo[] {
    const priorJobNames: string[] = this.schema.jobs[this.context.job].needs
    let jobDetails = priorJobNames
      .map(jobName => this.schema.jobs[jobName])
      .map((config: any) =>
        workflowJobs.filter(job => {
          return job.name.startsWith(config.name)
        })
      )
      .flat()

    return jobDetails
  }

  /**
   * Gather the outputs for the job runs and put them into an array.
   */
  async getJobOutputs(jobDetails: JobInfo[]) {
    const jobArtifacts: (Artifact | undefined)[] = jobDetails
      .map(j => j.id.toString())
      .map(jobId => {
        return this.artifacts.find((a: Artifact) => {
          core.info(
            `Looking for Artifact "${a.name}" that matches "${jobId}" == (${a.name == jobId})`
          )
          return a.name == jobId
        })
      })

    core.info(
      `Found Artifacts (${JSON.stringify(jobArtifacts.map(a => (a || { id: '' }).id))})`
    )

    const firstArtifact = jobArtifacts[0] || { id: 0 }
    // download the artifact as a temp file and decompress it
    const response = await this.octokit.rest.actions.downloadArtifact({
      ...this.commonQueryParams(),
      artifact_id: firstArtifact.id,
      archive_format: 'zip'
    })
    core.info('Artifact Content:')
    core.info(JSON.stringify(response.data))
    // load the file as JSON
    // return the data structure as an array of objects
    return {}
  }

  /**
   * Return the array as outputs for this job.
   */
  defineActionOutputs() {}
}
