import * as core from '@actions/core'
import * as github from '@actions/github'
import Axios from 'axios'
import * as tmp from 'tmp'
import YAML from 'yaml'
import { Context } from '@actions/github/lib/context'
import { Octokit } from '@octokit/core'
import { PaginateInterface } from '@octokit/plugin-paginate-rest'
import { Api } from '@octokit/plugin-rest-endpoint-methods/dist-types/types'
import * as fs from 'fs'
import * as unzipper from 'unzipper'

/**
 * Inferred by VSCode typescript interpreter inspection of Octokit response objects.
 */
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
        completed_at?: string | null | undefined
      }[]
    | undefined
  check_run_url: string
  labels: string[]
  runner_id: number | null
  runner_name: string | null
  runner_group_id: number | null
  runner_group_name: string | null
  workflow_name: string | null
  head_branch: string | null
}

/**
 * Inferred by VSCode typescript interpreter inspection of Octokit response objects.
 */
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
  schema: any

  /**
   * Initialize clients and member variables.
   */
  constructor() {
    tmp.setGracefulCleanup() // delete tmp files on process exit

    this.artifacts = []
    this.octokit = github.getOctokit(`${process.env.GITHUB_TOKEN}`)
    this.context = github.context
    core.debug('Context:')
    core.debug(JSON.stringify(this.context))
  }

  /**
   * Octokit query parameters that are used across multiple API requests.
   */
  commonQueryParams() {
    return {
      owner: this.context.payload.organization.login,
      repo: `${this.context.payload.repository?.name}`
    }
  }

  /**
   * Runtime entrypoint. Query for the last successful ran (not reran) jobs prior to this job and
   * return the content of the outputs JSON as an output of this job. Outputs of this job will have
   * the same key/name as the strings defined in the `needs` configuration.
   */
  async run() {
    this.schema = await this.getWorkflowSchema()
    this.artifacts = await this.getRunArtifacts()
    const results: { [n: string]: JobInfo[] } = {}
    for (let jobName of this.schema.jobs[this.context.job].needs) {
      const currentWorkflowJobs = await this.getRelevantWorkflowJobs(
        jobName,
        this.context.runId
      )
      const lastRanWorkflows = await this.getLastRanWorkflowJobs(
        jobName,
        currentWorkflowJobs
      )
      const jobOutputs = await this.getJobOutputs(lastRanWorkflows)
      core.setOutput(jobName, JSON.stringify(jobOutputs))
    }
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
    core.debug('Workflow Schema:')
    core.debug(JSON.stringify(schema))

    return schema
  }

  /**
   * Get jobs running within this workflow that are immediately preceding on this job, and have this
   * job as a dependent. If a workflow has been reran, this will iteratively query previous runs
   * until it can identify the job details that generated Artifacts.
   */
  async getLastRanWorkflowJobs(
    jobName: string,
    workflowJobs: JobInfo[]
  ): Promise<JobInfo[]> {
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
      jobName,
      this.context.runId,
      runAttempt - 1
    )
    // filter out the jobs that don't have the same name as the relevent ones from this run
    moreJobs = moreJobs.filter(job => reranJobNames.includes(job.name))
    // return the jobs to return while recursing in case we need to look back farther in the run attempts
    return jobsToReturn.concat(
      await this.getLastRanWorkflowJobs(jobName, moreJobs)
    )
  }

  /**
   * Query for and filter jobs only relevent for the dependency relation.
   */
  async getRelevantWorkflowJobs(
    jobName: string,
    runId: number,
    runAttempt: number | null = null
  ): Promise<JobInfo[]> {
    let workflowJobs = await this.getWorkflowJobs(runId, runAttempt)
    return this.filterForRelevantJobDetails(jobName, workflowJobs)
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

    core.debug('getWorkflowJobs:')
    core.debug(JSON.stringify(workflowJobs))

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
    core.debug('listWorkflowRunArtifacts')
    core.debug(JSON.stringify(response))

    return response.data.artifacts
  }

  /**
   * Get the job details for any job that ran with that same definition.
   */
  filterForRelevantJobDetails(
    jobName: string,
    workflowJobs: JobInfo[]
  ): JobInfo[] {
    const config = this.schema.jobs[jobName]
    return workflowJobs.filter(job => job.name.startsWith(config.name))
  }

  /**
   * Gather the outputs for the job runs and put them into an array.
   */
  async getJobOutputs(jobDetails: JobInfo[]): Promise<{ [k: string]: any }> {
    // create a data structure with the job name and associated artifact
    const jobArtifacts: { [k: string]: Artifact } = Object.fromEntries(
      new Map(
        jobDetails
          .map(job => [
            job.name,
            this.artifacts.find(a => a.name == job.id.toString())
          ])
          .filter(e => e[1] != undefined) as [string, Artifact][] // needed because the transcompiler can't tell we're filtering out undefined
      )
    )

    core.debug(
      `Found Artifacts (${JSON.stringify(Object.values(jobArtifacts).map(a => a.id))})`
    )

    // need to iterate to avoid defining async callbacks
    const jobResults: { [k: string]: any } = {}
    for (const jobName of Object.keys(jobArtifacts)) {
      let artifact = jobArtifacts[jobName]
      const artifactPath = await this.downloadArtifactFile(artifact)
      jobResults[jobName] = this.readOutputs(artifactPath)
    }
    core.info(`Job Outputs: ${JSON.stringify(jobResults)}`)

    // return the data structure as an array of objects
    return jobResults
  }

  /**
   * Download and unpack an artifact to a temporary directory. Return the directory name.
   */
  async downloadArtifactFile(artifact: Artifact): Promise<string> {
    const tmpFile = tmp.fileSync()
    const tmpDir = tmp.dirSync()

    // get the artifact download URL
    // artifacts are stored as zip files
    const response = await this.octokit.rest.actions.downloadArtifact({
      ...this.commonQueryParams(),
      artifact_id: artifact.id,
      archive_format: 'zip'
    })
    core.debug('Artifact URL Info:')
    core.debug(JSON.stringify(response))

    // download the zip file for the artifact
    await this.downloadFile(response.url, tmpFile.name)
    core.debug(`Artifact Zip File Saved To: ${tmpFile.name}`)

    // extract the artifact to a temporary directory
    await fs
      .createReadStream(tmpFile.name)
      .pipe(unzipper.Extract({ path: tmpDir.name }))
      .promise()
    core.debug(
      `Artifact Files Extracted To ${tmpDir.name}: ${JSON.stringify(fs.readdirSync(tmpDir.name))}`
    )

    return tmpDir.name
  }

  /**
   * Read the outputs from the artifact directory path.
   */
  readOutputs(artifactDirectoryPath: string): any {
    const readData = fs.readFileSync(`${artifactDirectoryPath}/outputs.json`, {
      encoding: 'utf8',
      flag: 'r'
    })
    core.debug(`Output File Contents: ${readData}`)
    return JSON.parse(readData)
  }

  /**
   * Download from a HTTPS endpoint and stream directly to file.
   *
   * Sourced from https://stackoverflow.com/questions/55374755/node-js-axios-download-file-stream-and-writefile
   */
  async downloadFile(fileUrl: string, outputLocationPath: string) {
    const writer = fs.createWriteStream(outputLocationPath)

    return Axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream'
    }).then(response => {
      return new Promise((resolve, reject) => {
        response.data.pipe(writer)
        let error: Error | null = null
        writer.on('error', err => {
          error = err
          writer.close()
          reject(err)
        })
        writer.on('close', () => {
          if (!error) {
            resolve(true)
          }
          //no need to call the reject here, as it will have been called in the
          //'error' stream;
        })
      })
    })
  }
}
