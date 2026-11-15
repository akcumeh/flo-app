import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client, type AuthSession } from '../api';
import { Button } from '../components/ui';
import { readGoogleReturn } from '../lib/google';
import { useAccount } from '../state/AccountContext';
import { AuthIntro } from './SignInScreen';
import s from './Auth.module.scss';

const REASONS = {
    cancelled: 'Google sign-in was cancelled.',
    mismatch: 'That sign-in did not start here. Try again.',
    missing: 'Google did not send a sign-in back. Try again.',
};

export function GoogleReturnScreen() {
    const navigate = useNavigate();
    const { signedIn } = useAccount();
    const [error, setError] = useState<string | null>(null);
    const done = useRef(false);

    useEffect(() => {
        if (done.current) return;
        done.current = true;
        const result = readGoogleReturn(window.location.hash);
        history.replaceState(null, '', window.location.pathname);
        if (!result.ok) {
            setError(REASONS[result.reason]);
            return;
        }
        client
            .POST('/v1/auth/google', { body: { idToken: result.idToken } })
            .then(({ data }) => {
                signedIn(data as AuthSession);
                navigate(result.from, { replace: true });
            })
            .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : 'Google sign-in failed.')
            );
    }, [navigate, signedIn]);

    return (
        <div className={s.page}>
            <AuthIntro />
            <main className={s.panel}>
                {error ? (
                    <>
                        <h1 className={s.title}>Could not sign in</h1>
                        <p className={s.lead} role="alert">
                            {error}
                        </p>
                        <Button block onClick={() => navigate('/signin', { replace: true })}>
                            Back to sign in
                        </Button>
                    </>
                ) : (
                    <>
                        <h1 className={s.title}>Signing you in</h1>
                        <p className={s.lead} role="status">
                            One moment.
                        </p>
                    </>
                )}
            </main>
        </div>
    );
}
