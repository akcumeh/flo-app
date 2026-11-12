import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, client, type AuthSession } from '../api';
import { Icon } from '../components/Icon';
import { Button, OtpField } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import { AuthIntro } from './SignInScreen';
import s from './Auth.module.scss';

const RESEND_SECONDS = 30;

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many tries. Ask for a new code in a few minutes.';
    if (err.status === 400) return "That code didn't work. Check it and try again.";
    return err.message;
  }
  return 'Could not check the code. Try again.';
}

export function VerifyScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { email?: string; from?: string } | null;
  const { signedIn } = useAccount();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  if (!state?.email) return <Navigate to="/signin" replace />;
  const email = state.email;
  const back = () => navigate('/signin', { state: { from: state.from } });

  const verify = async (value = code) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await client.POST('/v1/auth/email/verify', { body: { email, code: value } });
      signedIn(data as AuthSession);
      navigate(state.from ?? '/home', { replace: true });
    } catch (err) {
      setError(messageFor(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setWait(RESEND_SECONDS);
    setError(null);
    try {
      await client.POST('/v1/auth/email/start', { body: { email } });
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <div className={s.page}>
      <AuthIntro />
      <main className={s.panel}>
        <button type="button" className={s.back} aria-label="Back" onClick={back}>
          <Icon name="arrow-left" />
        </button>
        <h1 className={s.title}>Enter the 6-digit code</h1>
        <p className={s.lead}>We sent it to {email}.</p>
        <button type="button" className={s.link} onClick={back}>
          Wrong email?
        </button>
        <div className={s.form}>
          <OtpField label="Sign-in code" value={code} onChange={setCode} onComplete={(v) => void verify(v)} autoFocus disabled={busy} />
          {error ? (
            <p className={s.error} role="alert">
              {error}
            </p>
          ) : null}
          {wait > 0 ? (
            <p className={s.resend}>Resend code in 0:{String(wait).padStart(2, '0')}</p>
          ) : (
            <button type="button" className={s.link} onClick={() => void resend()}>
              Resend code
            </button>
          )}
        </div>
        <div className={s.footer}>
          <Button block disabled={code.length !== 6} loading={busy} onClick={() => void verify()}>
            Verify
          </Button>
        </div>
      </main>
    </div>
  );
}
