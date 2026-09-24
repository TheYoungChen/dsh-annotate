/**
 * Type surface for CSS Modules.
 *
 * The class keys are only known to the bundler, so the default export is a
 * read-only string map; every lookup returns `string | undefined` under
 * `noUncheckedIndexedAccess`, which is why the component's class helper
 * tolerates a missing key rather than asserting one.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

/** A plain stylesheet import is a side effect only. */
declare module '*.css'
