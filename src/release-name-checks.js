function unavailableResult(httpStatus = null) {
  return {
    checked: false,
    packageExists: null,
    targetVersionAvailable: null,
    httpStatus,
    latest: null,
    existingVersions: [],
    maintainers: [],
  };
}

export function evaluateNpmRegistryPackage(
  response,
  packageMetadata,
) {
  if (response?.status === 404) {
    return {
      checked: true,
      packageExists: false,
      targetVersionAvailable: true,
      httpStatus: 404,
      latest: null,
      existingVersions: [],
      maintainers: [],
    };
  }
  if (
    response?.status !== 200 ||
    response.body === null ||
    typeof response.body !== "object" ||
    Array.isArray(response.body) ||
    response.body.name !== packageMetadata.name ||
    response.body.versions === null ||
    typeof response.body.versions !== "object" ||
    Array.isArray(response.body.versions)
  ) {
    return unavailableResult(response?.status ?? null);
  }
  const existingVersions = Object.keys(
    response.body.versions,
  ).sort();
  const maintainers = Array.isArray(
    response.body.maintainers,
  )
    ? response.body.maintainers
        .map(({ name }) => name)
        .filter(
          (name) =>
            typeof name === "string" && name !== "",
        )
    : [];
  return {
    checked: true,
    packageExists: true,
    targetVersionAvailable:
      !Object.prototype.hasOwnProperty.call(
        response.body.versions,
        packageMetadata.version,
      ),
    httpStatus: 200,
    latest:
      typeof response.body["dist-tags"]?.latest ===
      "string"
        ? response.body["dist-tags"].latest
        : null,
    existingVersions,
    maintainers,
  };
}
