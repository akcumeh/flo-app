import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, client, idempotencyKey } from '../api';
import type { components } from '../api/schema';
import { AppBar } from '../components/AppBar';
import { Icon, type IconName } from '../components/Icon';
import { Button, ErrorState, Field, Skeleton } from '../components/ui';
import { leaveTo } from '../lib/leave';
import { useAccount } from '../state/AccountContext';
import s from './Tokens.module.scss';

type LedgerEntry = components['schemas']['LedgerEntry'];
type Bundle = components['schemas']['Bundle'];
type Purchase = components['schemas']['Purchase'];

const COSTS: Array<{ icon: IconName; label: string; cost: string }> = [
    { icon: 'row-chat', label: 'Ask Florence a question', cost: '1' },
    { icon: 'row-chat', label: 'Ask with a photo or file', cost: '2' },
    { icon: 'row-cards', label: 'Prep, per question (at least 3)', cost: '1' },
    { icon: 'row-file', label: 'Upload notes', cost: 'Free' },
];

const REASON: Record<LedgerEntry['reason'], { icon: IconName; label: string }> = {
    welcome_grant: { icon: 'row-bolt', label: 'Welcome tokens' },
    student_bonus: { icon: 'row-bolt', label: 'Student bonus' },
    streak_reward: { icon: 'row-bolt', label: 'Streak reward' },
    purchase: { icon: 'row-bolt', label: 'Top up' },
    chat_charge: { icon: 'row-chat', label: 'Ask Florence' },
    prep_charge: { icon: 'row-cards', label: 'Prep session' },
    create_charge: { icon: 'row-cards', label: 'Study set' },
    refund: { icon: 'row-bolt', label: 'Refund' },
    referral_reward: { icon: 'row-bolt', label: 'Invite reward' },
    merge_in: { icon: 'row-bolt', label: 'Moved from your other account' },
    merge_out: { icon: 'row-bolt', label: 'Moved to your other account' },
    legacy_import: { icon: 'row-bolt', label: 'Carried over from the chat bot' },
    admin_adjust: { icon: 'row-bolt', label: 'Adjustment' },
};

const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;
const signed = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);
const when = (iso: string) =>
    new Date(iso).toLocaleString('en-NG', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
    });
const RECENT = 5;
const MORE = 25;

export function TokensScreen() {
    const navigate = useNavigate();
    const { setBalance } = useAccount();
    const balance = useQuery({
        queryKey: ['tokens'],
        queryFn: async () => (await client.GET('/v1/tokens')).data!.balance,
    });
    const [expanded, setExpanded] = useState(false);
    const limit = expanded ? MORE : RECENT;
    const ledger = useQuery({
        queryKey: ['ledger', limit],
        queryFn: async () =>
            (await client.GET('/v1/tokens/ledger', { params: { query: { limit } } })).data!,
        placeholderData: (prev) => prev,
    });
    const entries = ledger.data?.items ?? [];

    useEffect(() => {
        if (balance.data !== undefined) setBalance(balance.data);
    }, [balance.data, setBalance]);

    return (
        <div className={s.page}>
            <AppBar title="Tokens" />
            <main className={s.content}>
                <section className={s.balance} aria-live="polite">
                    {balance.isPending ? (
                        <Skeleton height={48} width={120} />
                    ) : (
                        <p className={s.balanceRow}>
                            <span className={s.balanceNum}>{balance.data ?? 0}</span>
                            <span className={s.balanceUnit}>
                                {balance.data === 1 ? 'token left' : 'tokens left'}
                            </span>
                        </p>
                    )}
                    <p className={s.balanceNote}>Keep a 7-day streak to earn 10 free tokens.</p>
                </section>

                <h2 className={s.label}>What things cost</h2>
                <ul className={s.group}>
                    {COSTS.map((c) => (
                        <li key={c.label} className={s.row}>
                            <Icon name={c.icon} className={s.rowIcon} />
                            <span className={s.rowText}>{c.label}</span>
                            <span className={s.rowValue}>{c.cost}</span>
                        </li>
                    ))}
                </ul>

                <h2 className={s.label}>Recent</h2>
                {ledger.isError ? (
                    <ErrorState onRetry={() => void ledger.refetch()} />
                ) : ledger.isPending ? (
                    <Skeleton height={112} radius={24} />
                ) : entries.length === 0 ? (
                    <p className={s.caption}>Nothing yet.</p>
                ) : (
                    <>
                        <ul className={s.group}>
                            {entries.map((e) => (
                                <li key={e.id} className={`${s.row} ${s.entry}`}>
                                    <Icon name={REASON[e.reason].icon} className={s.rowIcon} />
                                    <span className={s.rowText}>
                                        {REASON[e.reason].label}
                                        <span className={s.rowSub}>
                                            {e.detail ? `${e.detail} · ` : ''}
                                            {when(e.createdAt)}
                                        </span>
                                    </span>
                                    <span className={s.rowValue}>{signed(e.delta)}</span>
                                </li>
                            ))}
                        </ul>
                        {!expanded && ledger.data?.nextCursor ? (
                            <Button variant="link" block onClick={() => setExpanded(true)}>
                                Show more
                            </Button>
                        ) : null}
                    </>
                )}
            </main>
            <div className={s.spacer} />
            <footer className={s.footer}>
                <Button block onClick={() => navigate('/tokens/top-up')}>
                    Top up
                </Button>
            </footer>
        </div>
    );
}

function bestValue(bundles: Bundle[]): string | null {
    if (bundles.length < 2) return null;
    return bundles.reduce((a, b) => (b.tokens / b.amountNaira > a.tokens / a.amountNaira ? b : a))
        .id;
}

export function TopUpScreen() {
    const bundles = useQuery({
        queryKey: ['bundles'],
        queryFn: async () => (await client.GET('/v1/tokens/bundles')).data!.items,
        staleTime: 3_600_000,
    });
    const [picked, setPicked] = useState<string | null>(null);
    const [email, setEmail] = useState('');
    const [needEmail, setNeedEmail] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const keys = useRef(new Map<string, string>());

    const items = bundles.data ?? [];
    const best = bestValue(items);
    const selected = picked ?? items[1]?.id ?? items[0]?.id ?? null;

    const pay = async () => {
        if (!selected) return;
        setBusy(true);
        setError(null);
        const slot = `${selected}:${needEmail ? email.trim() : ''}`;
        const key = keys.current.get(slot) ?? idempotencyKey();
        keys.current.set(slot, key);
        try {
            const res = await client.POST('/v1/tokens/purchases', {
                params: { header: { 'Idempotency-Key': key } },
                body: needEmail
                    ? { bundleId: selected, email: email.trim() }
                    : { bundleId: selected },
            } as never);
            const purchase = (res as { data?: Purchase }).data;
            if (purchase?.authorizationUrl) {
                leaveTo(purchase.authorizationUrl);
                return;
            }
            setError('Payment could not start. Try again in a moment.');
        } catch (err) {
            if (err instanceof ApiError && err.code === 'email_required') {
                setNeedEmail(true);
                setError(null);
            } else if (err instanceof ApiError && err.status === 0) {
                setError('You seem to be offline. Try again.');
            } else {
                setError(
                    err instanceof ApiError ? err.message : 'Payment could not start. Try again.'
                );
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={s.page}>
            <AppBar title="Top up" />
            <main className={s.content}>
                <h2 className={s.title}>Get more tokens</h2>
                {bundles.isError ? (
                    <ErrorState onRetry={() => void bundles.refetch()} />
                ) : bundles.isPending ? (
                    <>
                        <Skeleton height={84} radius={24} />
                        <Skeleton height={84} radius={24} />
                        <Skeleton height={84} radius={24} />
                    </>
                ) : (
                    <div className={s.plans} role="radiogroup" aria-label="Token bundles">
                        {items.map((b) => {
                            const on = b.id === selected;
                            return (
                                <button
                                    key={b.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    className={`${s.plan} ${on ? s.planOn : ''}`}
                                    onClick={() => setPicked(b.id)}
                                >
                                    <span className={s.radio} aria-hidden="true" />
                                    <span className={s.planText}>
                                        <span className={s.planName}>
                                            {b.tokens} tokens
                                            {b.id === best ? (
                                                <span className={s.planBadge}>Best value</span>
                                            ) : null}
                                        </span>
                                        <span className={s.planSub}>
                                            {naira(Math.round(b.amountNaira / b.tokens))} a token
                                        </span>
                                    </span>
                                    <span className={s.planPrice}>{naira(b.amountNaira)}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                {needEmail ? (
                    <Field
                        label="Email for your receipt"
                        type="email"
                        autoComplete="email"
                        inputMode="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        hint="Paystack sends the receipt here."
                    />
                ) : null}
                <p className={s.caption}>
                    Pay by card, bank transfer or USSD on Paystack. Tokens arrive as soon as the
                    payment clears.
                </p>
                {error ? (
                    <p className={s.error} role="alert">
                        {error}
                    </p>
                ) : null}
            </main>
            <div className={s.spacer} />
            <footer className={s.footer}>
                <Button
                    block
                    loading={busy}
                    disabled={!selected || (needEmail && !/^\S+@\S+\.\S+$/.test(email.trim()))}
                    onClick={() => void pay()}
                >
                    Continue to payment
                </Button>
            </footer>
        </div>
    );
}

const POLL_MS = 3000;

export function TopUpReturnScreen() {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const reference = params.get('reference') ?? params.get('trxref') ?? '';
    const { setBalance } = useAccount();
    const purchase = useQuery({
        queryKey: ['purchase', reference],
        enabled: Boolean(reference),
        queryFn: async () =>
            (
                await client.GET('/v1/tokens/purchases/{reference}', {
                    params: { path: { reference } },
                })
            ).data!,
        refetchInterval: (q) => {
            const st = q.state.data?.status;
            return st === 'pending' || st === 'awaiting_transfer' ? POLL_MS : false;
        },
    });
    const status = purchase.data?.status;

    useEffect(() => {
        if (status !== 'success') return;
        void client.GET('/v1/tokens').then((r) => {
            if (r.data) setBalance(r.data.balance);
        });
    }, [status, setBalance]);

    if (!reference || purchase.isError) {
        return (
            <div className={s.page}>
                <AppBar title="Payment" back="/tokens" />
                <main className={s.content}>
                    <h2 className={s.title}>We couldn’t find that payment</h2>
                    <p className={s.lead}>
                        If you were charged, your tokens still arrive once Paystack confirms. Check
                        your balance in a few minutes.
                    </p>
                </main>
                <div className={s.spacer} />
                <footer className={s.footer}>
                    <Button block onClick={() => navigate('/tokens', { replace: true })}>
                        See my tokens
                    </Button>
                </footer>
            </div>
        );
    }

    const transfer = purchase.data?.transfer;
    return (
        <div className={s.page}>
            <AppBar title="Payment" back="/tokens" />
            <main className={s.content} aria-live="polite">
                {status === 'success' ? (
                    <>
                        <span className={`${s.stateIcon} ${s.stateOk}`}>
                            <Icon name="check-circle-fill" />
                        </span>
                        <h2 className={s.title}>Payment received</h2>
                        <p className={s.lead}>Your tokens are in. Happy studying.</p>
                    </>
                ) : status === 'failed' || status === 'expired' ? (
                    <>
                        <span className={`${s.stateIcon} ${s.stateBad}`}>
                            <Icon name="warning-fill" />
                        </span>
                        <h2 className={s.title}>Payment didn’t go through</h2>
                        <p className={s.lead}>Nothing was taken from your account. Try again.</p>
                    </>
                ) : status === 'awaiting_transfer' && transfer ? (
                    <>
                        <h2 className={s.title}>Waiting for your transfer</h2>
                        <p className={s.lead}>
                            Send the exact amount to this account. We’ll add your tokens as soon as
                            it lands.
                        </p>
                        <ul className={s.group}>
                            <li className={s.row}>
                                <span className={s.rowText}>Bank</span>
                                <span className={s.rowValue}>{transfer.bankName}</span>
                            </li>
                            <li className={s.row}>
                                <span className={s.rowText}>Account number</span>
                                <span className={s.rowValue}>{transfer.accountNumber}</span>
                            </li>
                            <li className={s.row}>
                                <span className={s.rowText}>Account name</span>
                                <span className={s.rowValue}>{transfer.accountName}</span>
                            </li>
                        </ul>
                    </>
                ) : (
                    <>
                        <Skeleton height={56} width={56} radius={28} />
                        <h2 className={s.title}>Checking your payment</h2>
                        <p className={s.lead}>This usually takes a few seconds.</p>
                    </>
                )}
            </main>
            <div className={s.spacer} />
            <footer className={s.footer}>
                {status === 'failed' || status === 'expired' ? (
                    <Button block onClick={() => navigate('/tokens/top-up', { replace: true })}>
                        Try again
                    </Button>
                ) : (
                    <Button block onClick={() => navigate('/home', { replace: true })}>
                        Back to Florence
                    </Button>
                )}
            </footer>
        </div>
    );
}
