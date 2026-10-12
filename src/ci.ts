/** Variables set by common CI providers. */
export const CI_VARIABLES = [
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "DRONE",
  "APPVEYOR",
  "SEMAPHORE",
] as const;

export interface CiDetection {
  ci: boolean;
  source: string;
}

/**
 * Decides whether this is a CI run, where verification defaults to the full
 * suite. Environment variables can only turn CI mode on: a truthy `CI` or any
 * provider variable means CI, and nothing (including `CI=false`, which some
 * build setups export for unrelated reasons) can switch a detected provider
 * off. Selective runs in CI require an explicit `--changed` or `--changed-since`.
 */
export function detectCi(env: NodeJS.ProcessEnv): CiDetection {
  if (isEnabled(env.CI)) return { ci: true, source: "CI" };
  const provider = CI_VARIABLES.find((name) => isEnabled(env[name]));
  return provider ? { ci: true, source: provider } : { ci: false, source: "none" };
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
