/**
 * The privacy boundary for element facts.
 *
 * An annotation carries a form field's current value to the model, and that
 * value can be a credential. The boundary is therefore drawn here, in one
 * module, so there is exactly one place to audit: a caller asks this module
 * whether a field is sensitive and, if it is, receives a placeholder instead of
 * the contents. The real value is never read, so it cannot leak through a later
 * refactor that forgets to trim a string.
 *
 * Two rules keep the check trustworthy:
 *
 * 1. **Realm-independent.** An element reaching this code may originate in the
 *    page's own world, in a frame with its own globals, or in a test harness. A
 *    brand check such as `el instanceof HTMLInputElement` fails for every one of
 *    those while the element is still a real password box, so classification
 *    goes through attributes and accessors rather than constructors. A privacy
 *    gate that can be defeated by which realm a node came from is not a gate.
 * 2. **Fail closed.** A field is sensitive when its kind says so (a password
 *    input, a credit-card autocomplete field) or when any of its identifying
 *    names suggests secret material. The pattern list is deliberately broad: a
 *    false positive costs the model one masked value, while a false negative
 *    costs the user a credential.
 *
 * @module
 */

/**
 * Fragments in a field's id, name or label that mark it as secret material.
 * Matching is case-insensitive and substring-based, because pages spell these
 * inconsistently (`userPassword`, `user_password`, `txtPwd`).
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /pass(word|wd|phrase)?/i,
  /pwd/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /\bpin\b/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /credit/i,
  /\bcard\b/i,
  /\biban\b/i,
  /\bssn\b/i,
]

/** The placeholder that stands in for a value the model may not see. */
const MASK = '••••'

/**
 * A string-valued field read without assuming a realm and without throwing.
 *
 * Attributes are preferred over properties because an attribute is what the
 * author wrote and what a consumer can re-read; the property is the fallback for
 * a control whose state was set programmatically without being reflected.
 *
 * @param el - the element to read.
 * @param attribute - attribute name to prefer.
 * @param property - property to fall back to.
 * @returns the value, or the empty string when absent or unreadable.
 */
function fieldText(el: Element, attribute: string, property: string): string {
  try {
    const declared = el.getAttribute(attribute)
    if (declared !== null) return declared
  } catch {
    // An element whose attribute access throws cannot be asked anything else.
    return ''
  }
  try {
    const live: unknown = (el as unknown as Record<string, unknown>)[property]
    return typeof live === 'string' ? live : ''
  } catch {
    return ''
  }
}

/** An attribute value, or the empty string when absent or unreadable. */
function attributeOf(el: Element, name: string): string {
  try {
    return el.getAttribute(name) ?? ''
  } catch {
    return ''
  }
}

/** A lowercase tag name, or the empty string when even that is unreadable. */
function tagNameOf(el: Element): string {
  try {
    return el.tagName.toLowerCase()
  } catch {
    return ''
  }
}

/** An element's id, or the empty string. */
function elementId(el: Element): string {
  try {
    return el.id
  } catch {
    return attributeOf(el, 'id')
  }
}

/**
 * Whether a field must never be echoed back to the model.
 *
 * @param el - the form element to classify.
 * @returns `true` when the element is a password box, a credit-card
 *   autocomplete field, or a control whose id, name, placeholder or
 *   `aria-label` names it like a secret.
 */
export function isSensitiveField(el: Element): boolean {
  const tag = tagNameOf(el)

  if (tag === 'input' || tag === 'textarea') {
    if (fieldText(el, 'type', 'type').toLowerCase() === 'password') return true

    // `autocomplete` is the author's explicit statement about the data in the
    // field, so it is trusted ahead of every heuristic below it.
    const autocomplete = fieldText(el, 'autocomplete', 'autocomplete').toLowerCase()
    if (autocomplete === 'credit-card' || autocomplete.startsWith('cc-')) return true
  }

  const ownName = tag === 'input' || tag === 'textarea' || tag === 'select'
    ? fieldText(el, 'name', 'name')
    : ''
  const identifiers = [
    elementId(el),
    ownName,
    attributeOf(el, 'aria-label'),
    attributeOf(el, 'placeholder'),
  ].filter((part) => part !== '').join(' ')

  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(identifiers))
}

/**
 * Replace a value that must not leave the page.
 *
 * The shape of the result is deliberate: an empty field stays empty, so a reader
 * can tell "the user left this blank" from "there is a value here that you may
 * not see" without ever learning what the value is.
 *
 * @param value - the field's current value.
 * @returns the placeholder, or the empty string for an empty value.
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : MASK
}
