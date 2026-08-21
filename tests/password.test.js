import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePasswordPolicy } from '../src/utils/password.js'

test('accepts a password meeting all policy rules', () => {
  assert.equal(validatePasswordPolicy('Str0ng!Pass'), null)
})

test('rejects a password shorter than 8 characters', () => {
  assert.match(validatePasswordPolicy('Sh0rt!'), /8 characters/)
})

test('rejects a password with no uppercase letter', () => {
  assert.match(validatePasswordPolicy('str0ng!pass'), /uppercase/)
})

test('rejects a password with no lowercase letter', () => {
  assert.match(validatePasswordPolicy('STR0NG!PASS'), /lowercase/)
})

test('rejects a password with no number', () => {
  assert.match(validatePasswordPolicy('Strong!Pass'), /number/)
})

test('rejects a password with no special character', () => {
  assert.match(validatePasswordPolicy('Str0ngPass'), /special character/)
})

test('rejects a non-string password', () => {
  assert.match(validatePasswordPolicy(undefined), /required/)
  assert.match(validatePasswordPolicy(12345678), /required/)
})
