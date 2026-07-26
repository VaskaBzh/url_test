/** Validated request payload used to create an asynchronous URL-checking job. */
export interface CreateJobDto {
  readonly urls: readonly string[];
}
