import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { questionnaireFingerprint } from '../src/server/window-monitor.js';
import type { Questionnaire } from '../src/server/types.js';

function makeQuestionnaire(overrides: Partial<Questionnaire> = {}): Questionnaire {
  return {
    questions: [
      {
        number: '1.',
        text: 'How should I re-land it?',
        isActive: true,
        options: [
          { letter: 'A', label: 'Push a fresh branch', isFreeform: false, selectorPath: 'a' },
          { letter: 'B', label: "Don't open a PR", isFreeform: false, selectorPath: 'b' },
        ],
      },
    ],
    activeIndex: 0,
    totalLabel: '1 of 1',
    skipSelectorPath: 'skip',
    continueSelectorPath: 'continue',
    continueDisabled: true,
    ...overrides,
  };
}

describe('questionnaireFingerprint', () => {
  it('returns empty string for null or empty questionnaires', () => {
    assert.equal(questionnaireFingerprint(null), '');
    assert.equal(
      questionnaireFingerprint(makeQuestionnaire({ questions: [] })),
      ''
    );
  });

  it('changes when a questionnaire first appears (drives the per-window emit)', () => {
    const before = questionnaireFingerprint(null);
    const after = questionnaireFingerprint(makeQuestionnaire());
    assert.notEqual(before, after);
  });

  it('changes when the active question advances', () => {
    const q1 = makeQuestionnaire({
      questions: [
        makeQuestionnaire().questions[0],
        { number: '2.', text: 'Second?', isActive: false, options: [] },
      ],
      totalLabel: '1 of 2',
      activeIndex: 0,
    });
    const q2 = makeQuestionnaire({
      questions: q1.questions,
      totalLabel: '2 of 2',
      activeIndex: 1,
    });
    assert.notEqual(questionnaireFingerprint(q1), questionnaireFingerprint(q2));
  });

  it('changes when the continue button toggles enabled/disabled', () => {
    const disabled = makeQuestionnaire({ continueDisabled: true });
    const enabled = makeQuestionnaire({ continueDisabled: false });
    assert.notEqual(questionnaireFingerprint(disabled), questionnaireFingerprint(enabled));
  });

  it('changes when an option label changes', () => {
    const first = makeQuestionnaire();
    const second = makeQuestionnaire({
      questions: [
        {
          ...first.questions[0],
          options: [
            first.questions[0].options[0],
            { ...first.questions[0].options[1], label: 'Open a focused PR' },
          ],
        },
      ],
    });

    assert.notEqual(questionnaireFingerprint(first), questionnaireFingerprint(second));
  });

  it('is stable for identical questionnaires (no spurious re-emits)', () => {
    assert.equal(
      questionnaireFingerprint(makeQuestionnaire()),
      questionnaireFingerprint(makeQuestionnaire())
    );
  });
});
