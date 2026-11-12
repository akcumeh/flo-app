import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, client, type AuthSession } from '../api';
import { Icon } from '../components/Icon';
import { Button, Field } from '../components/ui';
import { GOOGLE_CLIENT_ID, loadGoogle } from '../lib/google';
import { useAccount } from '../state/AccountContext';
import s from './Auth.module.scss';

export function AuthIntro() {
    return (
        <section className={s.intro}>
            <Icon name="logo-florence" />
            <h1 className={s.introTitle}>Practise from your own notes.</h1>
            <p className={s.introBody}>
                Florence turns your lecture notes into questions, marks your answers and explains
                every step.
            </p>
        </section>
    );
}

function GoogleButton({ from, onError }: { from: string; onError: (message: string) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { signedIn } = useAccount();

    useEffect(() => {
        if (!GOOGLE_CLIENT_ID || !ref.current) return;
        let live = true;
        loadGoogle()
            .then((g) => {
                if (!live || !ref.current) return;
                g.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    ux_mode: 'popup',
                    callback: async ({ credential }) => {
                        try {
                            const { data } = await client.POST('/v1/auth/google', {
                                body: { idToken: credential },
                            });
                            signedIn(data as AuthSession);
                            navigate(from, { replace: true });
                        } catch (err) {
                            onError(err instanceof Error ? err.message : 'Google sign-in failed.');
                        }
                    },
                });
                g.renderButton(ref.current, {
                    type: 'standard',
                    theme: 'outline',
                    size: 'large',
                    shape: 'pill',
                    text: 'continue_with',
                    logo_alignment: 'center',
                    width: Math.min(ref.current.offsetWidth || 360, 400),
                });
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [from, navigate, onError, signedIn]);

    if (!GOOGLE_CLIENT_ID) return null;
    return <div ref={ref} className={s.google} aria-label="Continue with Google" />;
}

function TelegramButton({ from, onError }: { from: string; onError: (message: string) => void }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);

    const start = async () => {
        setBusy(true);
        const tab = window.open('', '_blank');
        try {
            const { data } = await client.POST('/v1/auth/challenges', {
                body: { channel: 'telegram', intent: 'signin' },
            });
            if (tab && data?.deepLink) tab.location.href = data.deepLink;
            navigate('/signin/telegram', { state: { ...data, from, opened: Boolean(tab) } });
        } catch (err) {
            tab?.close();
            onError(err instanceof Error ? err.message : 'Telegram sign-in is not available.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button variant="secondary" block loading={busy} onClick={() => void start()}>
            <Icon name="telegram" />
            Continue with Telegram
        </Button>
    );
}

export function SignInScreen() {
    const navigate = useNavigate();
    const location = useLocation();
    const from = (location.state as { from?: string } | null)?.from ?? '/home';
    const [phone, setPhone] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (phone.replace(/\D/g, '').length < 7) {
            setError('Enter the number you use on WhatsApp, like 0803 123 4567.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { data } = await client.POST('/v1/auth/whatsapp/start', { body: { phone } });
            navigate('/signin/code', { state: { ...data, from } });
        } catch (err) {
            if (err instanceof ApiError && err.status === 429)
                setError('Wait a moment before asking for another code.');
            else setError(err instanceof Error ? err.message : 'Could not send the code.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={s.page}>
            <AuthIntro />
            <main className={s.panel}>
                <button
                    type="button"
                    className={s.back}
                    aria-label="Back"
                    onClick={() => navigate(-1)}
                >
                    <Icon name="arrow-left" />
                </button>
                <h1 className={s.title}>Save your progress</h1>
                <p className={s.lead}>
                    Use the number you use on WhatsApp. If you've chatted with Florence there, we'll
                    bring that history in.
                </p>
                <form className={s.form} onSubmit={submit} noValidate>
                    <Field
                        label="Phone number"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="0803 123 4567"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        hint="We'll send a code on WhatsApp."
                        error={error}
                        autoFocus
                    />
                    <Button type="submit" block loading={busy}>
                        Send code
                    </Button>
                    <p className={s.or}>or</p>
                    <GoogleButton from={from} onError={setError} />
                    <TelegramButton from={from} onError={setError} />
                </form>
                <p className={s.terms}>
                    By continuing you agree to Florence's Terms and Privacy Policy.
                </p>
            </main>
        </div>
    );
}
