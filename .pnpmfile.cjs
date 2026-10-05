// @form-create/component-wangeditor pulls wangeditor@4 (unmaintained,
// unfixed XSS GHSA-g7mw-5cq6-fv82). Drop it from every @form-create/* manifest; the web app
// aliases the module to a local stub (apps/web/src/stubs/fc-wangeditor.ts). A hook instead of
// an override keeps blockExoticSubdeps on (no link:/workspace rewrites of transitive deps).
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name?.startsWith('@form-create/') && pkg.dependencies) {
        delete pkg.dependencies['@form-create/component-wangeditor']
      }
      return pkg
    },
  },
}
