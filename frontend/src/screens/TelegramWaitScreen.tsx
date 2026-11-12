import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, client, type AuthSession } from '../api';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import { AuthIntro } from './SignInScreen';
import s from './Auth.module.scss';

const POLL_MS = 2000;

interface TelegramState {
    challengeId?: string;
    code?: string;
    deepLink?: string;
    expiresAt?: string;
    from?: string;
}

type Phase = 'waiting' | 'signing-in' | 'expired' | 'failed';

export function TelegramWaitScreen() {
    const navigate = useNavigate();
    const location = useLocation();
    const state = (location.state as TelegramState | null) ?? {};
    const { signedIn } = useAccount();
    const [phase, setPhase] = useState<Phase>('waiting');
    const [error, setError] = useState<string | null>(null);
    const done = useRef(false);

    useEffect(() => {
        const id = state.challengeId;
        if (!id) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout>;

        const redeem = async () => {
            setPhase('signing-in');
            try {
                const { data } = await client.POST('/v1/auth/challenges/{challengeId}/redeem', {
                    params: { path: { challengeId: id } },
                });
                if (!live) return;
                done.current = true;
                signedIn(data as AuthSession);
                navigate(state.from ?? '/home', { replace: true });
            } catch (err) {
                if (!live) return;
                setPhase('failed');
                setError(err instanceof ApiError ? err.message : 'Could not finish signing in.');
            }
        };

        const poll = async () => {
            try {
                const { data } = await client.GET('/v1/auth/challenges/{challengeId}', {
                    params: { path: { challengeId: id } },
                });
                if (!live || done.current) return;
                if (data?.status === 'verified') {
                    await redeem();
                    return;
                }
                if (data?.status === 'expired' || data?.status === 'redeemed') {
                    setPhase('expired');
                    return;
                }
            } catch (err) {
                if (!live) return;
                if (err instanceof ApiError && err.status === 404) {
                    setPhase('expired');
                    return;
                }
            }
            timer = setTimeout(() => void poll(), POLL_MS);
        };

        timer = setTimeout(() => void poll(), POLL_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [state.challengeId, state.from, navigate, signedIn]);

    if (!state.challengeId || !state.deepLink) return <Navigate to="/signin" replace />;
    const back = () => navigate('/signin', { state: { from: state.from } });

    return (
        <div className={s.page}>
            <AuthIntro />
            <main className={s.panel}>
                <button type="button" className={s.back} aria-label="Back" onClick={back}>
                    <Icon name="arrow-left" />
                </button>
                {phase === 'expired' ? (
                    <>
                        <h1 className={s.title}>This link has expired</h1>
                        <p className={s.lead}>
                            Links last 10 minutes. Start again to get a new one.
                        </p>
                        <div className={s.footer}>
                            <Button block onClick={back}>
                                Start again
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <h1 className={s.title}>Tap Start in Telegram</h1>
                        <p className={s.lead}>
                            Florence opens in Telegram. Tap Start there and you'll be signed in
                            here.
                        </p>
                        <p className={s.resend} aria-live="polite">
                            {phase === 'signing-in'
                                ? 'Signing you in'
                                : `Waiting for Telegram. Your code is ${state.code}.`}
                        </p>
                        {error ? (
                            <p className={s.error} role="alert">
                                {error}
                            </p>
                        ) : null}
                        <div className={s.footer}>
                            <a
                                className={s.linkButton}
                                href={state.deepLink}
                                target="_blank"
                                rel="noreferrer"
                            >
                                <Icon name="telegram" />
                                Open Telegram
                            </a>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
