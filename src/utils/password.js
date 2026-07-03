// Password policy: min 8 chars, at least one uppercase, one lowercase,
// one number, and one special character.
const POLICY_REGEX = {
  length: /.{8,}/,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  number: /[0-9]/,
  special: /[^A-Za-z0-9]/,
}

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    return 'Password is required'
  }
  if (!POLICY_REGEX.length.test(password)) {
    return 'Password must be at least 8 characters long'
  }
  if (!POLICY_REGEX.upper.test(password)) {
    return 'Password must contain at least one uppercase letter'
  }
  if (!POLICY_REGEX.lower.test(password)) {
    return 'Password must contain at least one lowercase letter'
  }
  if (!POLICY_REGEX.number.test(password)) {
    return 'Password must contain at least one number'
  }
  if (!POLICY_REGEX.special.test(password)) {
    return 'Password must contain at least one special character'
  }
  return null // valid
}
