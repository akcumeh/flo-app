import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAccount } from '../state/AccountContext';
import { Button, Sheet } from './ui';
import s from './OutOfTokens.module.scss';

interface Need {
    what: string;
    cost: number;
}

const OutOfTokensContext = createContext<(need?: Need) => void>(() => {});

export function isOutOfTokens(err: unknown): boolean {
    return err instanceof ApiError && (err.code === 'insufficient_tokens' || err.status === 402);
}

export function OutOfTokensProvider({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const { account } = useAccount();
    const [need, setNeed] = useState<Need | null>(null);
    const show = useCallback((n?: Need) => setNeed(n ?? { what: 'This', cost: 1 }), []);
    const close = useCallback(() => setNeed(null), []);
    const balance = account?.tokenBalance ?? 0;

    return (
        <OutOfTokensContext.Provider value={show}>
            {children}
            <Sheet open={need !== null} onClose={close} title="You’re out of tokens">
                {need ? (
                    <p className={s.body}>
                        {need.what} needs {need.cost} {need.cost === 1 ? 'token' : 'tokens'} and you
                        have {balance}. Top up and you’ll start right where you left off.
                    </p>
                ) : null}
                <div className={s.actions}>
                    <Button
                        block
                        onClick={() => {
                            close();
                            navigate('/tokens/top-up');
                        }}
                    >
                        Top up
                    </Button>
                    <Button variant="link" block onClick={close}>
                        Not now
                    </Button>
                </div>
            </Sheet>
        </OutOfTokensContext.Provider>
    );
}

export function useOutOfTokens() {
    return useContext(OutOfTokensContext);
}
