import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type PrepResult, type PrepSession, type Verdict } from '../api';
import { Icon } from '../components/Icon';
import { useAccount } from '../state/AccountContext';
import s from './PrepSessionScreen.module.scss';

interface Answered {
  chosen: string;
  verdict: Verdict;
}

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function PrepSessionScreen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { setBalance } = useAccount();
  const [session, setSession] = useState<PrepSession | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<Answered | undefined>>([]);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PrepResult | null>(null);
  const [loadError, setLoadError] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api
      .getPrepSession(id)
      .then((sess) => {
        if (live) setSession(sess);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [id]);

  const answered = answers[index];

  useEffect(() => {
    if (answered) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [answered]);

  if (loadError) {
    return (
      <div className={s.page}>
        <p role="alert" className={s.fallback}>
          This session ended. Start a new one from Prep.
        </p>
        <button type="button" className={s.next} onClick={() => navigate('/prep')}>
          Back to Prep
        </button>
      </div>
    );
  }
  if (!session) return <div className={s.page} aria-busy="true" />;

  const total = session.items.length;
  const question = session.items[index];

  const choose = async (option: string) => {
    if (answered || pending) return;
    setPending(true);
    try {
      const verdict = await api.submitPrepAnswer(session.id, question.id, option);
      setAnswers((prev) => {
        const next = [...prev];
        next[index] = { chosen: option, verdict };
        return next;
      });
    } finally {
      setPending(false);
    }
  };

  const next = async () => {
    if (index + 1 < total) {
      setIndex(index + 1);
      window.scrollTo({ top: 0 });
      return;
    }
    const res = await api.completePrepSession(session.id);
    setBalance(res.balance ?? 0);
    setResult(res);
    window.scrollTo({ top: 0 });
  };

  const askAbout = () =>
    navigate('/ask', { state: { fromPrep: { question: index + 1, prompt: `Why does this work: ${question.prompt}` } } });

  if (result) {
    return (
      <div className={s.page}>
        <main className={s.result}>
          <p className={s.eyebrow}>Quiz done</p>
          <h1 className={s.score}>
            {result.score}/{result.total}
          </h1>
          <p className={s.sub}>
            {result.failedTopics.length > 0
              ? `Worth another look: ${result.failedTopics.join(', ')}.`
              : 'Every question right. Nice work.'}
          </p>
          <p className={s.sub}>
            {result.charged} tokens used. {result.balance} left.
          </p>
          <button type="button" className={s.next} onClick={() => navigate('/prep')}>
            Done
          </button>
          <button type="button" className={s.askLink} onClick={() => navigate('/ask')}>
            <Icon name="asterisk-action" />
            Ask Florence about this
          </button>
        </main>
      </div>
    );
  }

  const verdict = answered?.verdict;
  const correctIndex = verdict ? question.options?.indexOf(verdict.correctAnswer) ?? -1 : -1;
  const chosenIndex = answered ? question.options?.indexOf(answered.chosen) ?? -1 : -1;
  const correctKey = KEYS[correctIndex] ?? '';
  const chosenKey = KEYS[chosenIndex] ?? '';
  const right = verdict?.result === 'right';
  const isLast = index + 1 >= total;

  return (
    <div className={s.page}>
      <div className={s.topBar}>
        <button type="button" className={s.exit} aria-label="Exit Prep" onClick={() => navigate('/prep')}>
          <Icon name="close" />
        </button>
        <div className={s.progress} role="img" aria-label={`Question ${index + 1} of ${total}`}>
          {session.items.map((q, i) => {
            const a = answers[i];
            const state = !a ? 'todo' : a.verdict.result === 'right' ? 'right' : 'missed';
            return <span key={q.id} className={`${s.seg} ${s[state]}`} />;
          })}
        </div>
        <p className={s.count}>
          {index + 1}/{total}
        </p>
      </div>

      <div className={s.session}>
        <span className={s.badge}>
          FLORENCE<span className={s.star}>*</span> PREP
        </span>
        <p className={s.sessionName}>BIO 102 · Cell biology notes</p>
      </div>

      <section className={s.questionWrap}>
        <div className={s.questionCard}>
          <p className={s.kind}>MULTIPLE CHOICE · PICK ONE</p>
          <h1 className={s.question}>{question.prompt}</h1>
          <div className={s.options} role="group" aria-label="Answer options">
            {question.options?.map((option, i) => {
              const isChosen = answered?.chosen === option;
              const isCorrect = verdict?.correctAnswer === option;
              const state = !answered ? 'idle' : isCorrect ? 'correct' : isChosen ? 'wrong' : 'muted';
              return (
                <button
                  key={option}
                  type="button"
                  className={`${s.option} ${s[state]}`}
                  onClick={() => choose(option)}
                  disabled={Boolean(answered) || pending}
                  aria-pressed={isChosen}
                >
                  <span className={s.key}>{KEYS[i]}</span>
                  <span className={s.optionText}>{option}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {verdict && (
        <div ref={panelRef} className={`${s.panel} ${right ? s.panelRight : s.panelWrong}`}>
          <div className={s.verdict}>
            <p className={s.verdictLabel}>
              Question {index + 1} · {right ? 'nice' : 'keep going'}
            </p>
            <h2 className={s.verdictTitle}>{right ? 'Nailed it.' : 'Not quite.'}</h2>
            <p className={s.verdictSub}>
              {right ? `${correctKey} is right. Here’s why it wins.` : `The answer is ${correctKey}. Here’s why it wins.`}
            </p>
          </div>

          <div className={s.stack}>
            <div className={`${s.pill} ${s.pillRight}`}>
              <span className={`${s.pillKey} ${s.keyRight}`}>{correctKey}</span>
              <span className={s.pillText}>
                <span className={`${s.pillLabel} ${s.labelRight}`}>Right answer</span>
                <span className={s.pillBody}>{verdict.correctAnswer}</span>
              </span>
              <span className={`${s.badgeIcon} ${s.badgeRight}`}>
                <Icon name="check" />
              </span>
            </div>
            {!right && (
              <div className={`${s.pill} ${s.pillYours}`}>
                <span className={`${s.pillKey} ${s.keyWrong}`}>{chosenKey}</span>
                <span className={s.pillText}>
                  <span className={`${s.pillLabel} ${s.labelWrong}`}>Your answer</span>
                  <span className={s.pillBody}>{answered?.chosen}</span>
                </span>
                <span className={`${s.badgeIcon} ${s.badgeWrong}`}>
                  <Icon name="bang" />
                </span>
              </div>
            )}
          </div>

          {verdict.source && (
            <button type="button" className={s.source}>
              <span className={s.fileIcon}>
                <Icon name="doc" />
              </span>
              <span className={s.sourceText}>
                <span className={s.sourceLabel}>SOURCE</span>
                <span className={s.sourceName}>{verdict.source.label}</span>
                <span className={s.sourcePage}>
                  Page {verdict.source.page} · {question.topic}
                </span>
              </span>
              <Icon name="chevron" className={s.chevron} />
            </button>
          )}

          <div className={s.card}>
            <div className={s.cardHead}>
              <span className={`${s.mark} ${s.markRight}`}>
                <Icon name="check-small" />
              </span>
              <h3>Why {correctKey} wins</h3>
            </div>
            <p className={s.cardBody}>{verdict.whyRight}</p>
          </div>

          {verdict.whyOthersFail && verdict.whyOthersFail.length > 0 && (
            <div className={s.card}>
              <div className={s.cardHead}>
                <span className={`${s.mark} ${s.markWrong}`}>
                  <Icon name="bang-small" />
                </span>
                <h3>Why the others don’t fit</h3>
              </div>
              {verdict.whyOthersFail.map((other) => {
                const k = KEYS[question.options?.indexOf(other.option) ?? -1] ?? '';
                const mine = answered?.chosen === other.option;
                return (
                  <div key={other.option} className={s.other}>
                    <span className={`${s.smallKey} ${mine ? s.smallKeyMine : ''}`}>{k}</span>
                    <div>
                      {mine && <p className={s.mineLabel}>Your answer</p>}
                      <p className={s.otherText}>{other.reason}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {verdict.examTip && (
            <div className={s.tip}>
              <Icon name="asterisk-tip" />
              <div>
                <p className={s.tipTitle}>Exam tip</p>
                <p className={s.tipBody}>{verdict.examTip}</p>
              </div>
            </div>
          )}

          <div className={s.actions}>
            <button type="button" className={s.next} onClick={next}>
              {isLast ? 'See results' : 'Next question'}
              <Icon name="arrow-right" />
            </button>
            <button type="button" className={s.askLink} onClick={askAbout}>
              <Icon name="asterisk-action" />
              Ask Florence about this
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
