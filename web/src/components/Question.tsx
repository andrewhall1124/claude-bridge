import { useState } from "react";
import type { PendingQuestion } from "../hooks";
import type { QuestionAnswer } from "../protocol";

interface Props {
  pending: PendingQuestion;
  onRespond: (requestId: string, answers: QuestionAnswer[], cancelled?: boolean) => void;
}

export function Question({ pending, onRespond }: Props) {
  const { questions } = pending;
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [freeform, setFreeform] = useState<string[]>(() => questions.map(() => ""));
  const [submitted, setSubmitted] = useState(false);

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected((prev) => {
      const next = prev.map((s) => [...s]);
      const cur = next[qi] ?? [];
      if (multi) {
        next[qi] = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label];
      } else {
        next[qi] = cur.includes(label) ? [] : [label];
      }
      return next;
    });
  }

  function setOther(qi: number, value: string) {
    setFreeform((prev) => {
      const next = [...prev];
      next[qi] = value;
      return next;
    });
  }

  const canSubmit = questions.every(
    (_, qi) => (selected[qi]?.length ?? 0) > 0 || (freeform[qi]?.trim().length ?? 0) > 0,
  );

  function submit() {
    if (!canSubmit || submitted) return;
    setSubmitted(true);
    const answers: QuestionAnswer[] = questions.map((q, qi) => ({
      question: q.question,
      selected: selected[qi] ?? [],
      ...(freeform[qi]?.trim() ? { freeform: freeform[qi]!.trim() } : {}),
    }));
    onRespond(pending.requestId, answers);
  }

  function skip() {
    if (submitted) return;
    setSubmitted(true);
    onRespond(pending.requestId, [], true);
  }

  return (
    <div className="question-card">
      <div className="question-head">
        <span className="question-badge">question</span>
        <span className="subtle">Claude is asking you</span>
      </div>

      {questions.map((q, qi) => (
        <div className="question-block" key={qi}>
          {q.header && <span className="question-chip">{q.header}</span>}
          <p className="question-text">{q.question}</p>
          <div className="question-options">
            {q.options.map((opt) => {
              const active = (selected[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`option ${active ? "active" : ""}`}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                  disabled={submitted}
                >
                  <span className="option-label">
                    {q.multiSelect ? (active ? "[x]" : "[ ]") : active ? "(o)" : "( )"}{" "}
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="option-desc">{opt.description}</span>
                  )}
                  {opt.preview && <pre className="option-preview">{opt.preview}</pre>}
                </button>
              );
            })}
          </div>
          <input
            className="question-other"
            type="text"
            placeholder="Other (type your own answer)…"
            value={freeform[qi] ?? ""}
            onChange={(e) => setOther(qi, e.target.value)}
            disabled={submitted}
          />
          {q.multiSelect && <span className="subtle question-hint">Select all that apply</span>}
        </div>
      ))}

      <div className="question-actions">
        <button className="btn btn-primary" onClick={submit} disabled={!canSubmit || submitted}>
          Send answer
        </button>
        <button className="btn" onClick={skip} disabled={submitted}>
          Skip
        </button>
      </div>
    </div>
  );
}
