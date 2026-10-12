/** Variables set by common CI providers, checked when `CI` itself is absent. */
const CI_VARIABLES = [
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
 * Decides whether this is a CI run. `VERIFIKA_CI` overrides detection in either
 * direction; otherwise `CI` (unless "false" or "0") or a known provider variable
 * means CI.
 */
export function detectCi(env: NodeJS.ProcessEnv): CiDetection {
  const override = env.VERIFIKA_CI;
  if (override !== undefined && override !== "") {
    return { ci: isTruthy(override), source: "VERIFIKA_CI" };
  }
  if (env.CI !== undefined && env.CI !== "") {
    return { ci: isTruthy(env.CI), source: "CI" };
  }
  const provider = CI_VARIABLES.find((name) => env[name] !== undefined && env[name] !== "");
  return provider ? { ci: true, source: provider } : { ci: false, source: "none" };
}

function isTruthy(value: string): boolean {
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
