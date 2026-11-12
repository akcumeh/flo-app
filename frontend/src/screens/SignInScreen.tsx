import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, client } from '../api';
import { Icon } from '../components/Icon';
import { Button, Field } from '../components/ui';
import s from './Auth.module.scss';

export function AuthIntro() {
  return (
    <section className={s.intro}>
      <Icon name="logo-florence" />
      <h1 className={s.introTitle}>Practise from your own notes.</h1>
      <p className={s.introBody}>Florence turns your lecture notes into questions, marks your answers and explains every step.</p>
    </section>
  );
}

export function SignInScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/home';
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError('Enter a full email address, like ada@example.com.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.POST('/v1/auth/email/start', { body: { email: address } });
      navigate('/signin/code', { state: { email: address, from } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Too many codes for now. Try again in a few minutes.');
      else setError(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <AuthIntro />
      <main className={s.panel}>
        <button type="button" className={s.back} aria-label="Back" onClick={() => navigate(-1)}>
          <Icon name="arrow-left" />
        </button>
        <h1 className={s.title}>Save your progress</h1>
        <form className={s.form} onSubmit={submit} noValidate>
          <Field
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="ada@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            hint="We'll send a code by email."
            error={error}
            autoFocus
          />
          <Button type="submit" block loading={busy}>
            Send code
          </Button>
        </form>
        <p className={s.terms}>By continuing you agree to Florence's Terms and Privacy Policy.</p>
      </main>
    </div>
  );
}
