// Prompt jump: which lines count as a prompt and which one a press goes to.
//
// Run with: npx tsx --test src/__tests__/prompt-jump.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPromptLine, nextPromptIndex, promptLineIndices } from '../promptJump.ts'

test('isPromptLine: ❯ followed by text, with or without leading space', () => {
  assert.equal(isPromptLine('❯ pls continue'), true)
  assert.equal(isPromptLine('  ❯ ls -la'), true)
  assert.equal(isPromptLine('❯\tfix the tests'), true)
})

test('isPromptLine: the empty input box, blank rows and ordinary output are not prompts', () => {
  assert.equal(isPromptLine('❯'), false)
  assert.equal(isPromptLine('❯ '), false)
  assert.equal(isPromptLine(''), false)
  assert.equal(isPromptLine('root@foray:~# printf "❯ x"'), false)
  assert.equal(isPromptLine('  than framing this as a quality pass'), false)
})

test('promptLineIndices: every prompt line, in order', () => {
  const lines = ['hi', '❯ one', 'a', 'b', '❯ two', '❯', 'c']
  assert.deepEqual(promptLineIndices(lines), [1, 4])
  assert.deepEqual(promptLineIndices([]), [])
})

test('nextPromptIndex: the latest first, then each earlier one, wrapping to the latest', () => {
  const prompts = [1, 4, 9]
  assert.equal(nextPromptIndex(prompts, null), 9)
  assert.equal(nextPromptIndex(prompts, 9), 4)
  assert.equal(nextPromptIndex(prompts, 4), 1)
  assert.equal(nextPromptIndex(prompts, 1), 9)
})

test('nextPromptIndex: a previous index that no longer matches a prompt still steps to the one above it', () => {
  // The history was trimmed and the indices shifted under the reader.
  assert.equal(nextPromptIndex([1, 4, 9], 6), 4)
  assert.equal(nextPromptIndex([1, 4, 9], 0), 9)
})

test('nextPromptIndex: no prompts, nowhere to go', () => {
  assert.equal(nextPromptIndex([], null), null)
  assert.equal(nextPromptIndex([], 3), null)
})
