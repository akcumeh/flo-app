import { useQuery } from '@tanstack/react-query';
import { client } from '../api';
import { AppBar } from '../components/AppBar';
import { Button, Skeleton } from '../components/ui';
import { leaveTo } from '../lib/leave';
import { useAccount } from '../state/AccountContext';
import s from './Tokens.module.scss';

function device(): string {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac OS/.test(ua)) return 'Mac';
    return 'Web';
}

export function SupportScreen() {
    const { account } = useAccount();
    const status = useQuery({
        queryKey: ['status'],
        queryFn: async () => (await client.GET('/v1/status')).data!,
        staleTime: 300_000,
    });
    const support = status.data?.support;
    const who = [account?.id.slice(0, 8), account?.identities[0]?.display]
        .filter(Boolean)
        .join(' · ');
    const footer = `Account ${who} · Web app · ${device()}`;
    const message = `Hi Florence, I need help with…\n\n${footer}`;
    const whatsapp = support?.whatsapp
        ? `https://wa.me/${support.whatsapp}?text=${encodeURIComponent(message)}`
        : null;
    const email = support?.email
        ? `mailto:${support.email}?subject=${encodeURIComponent('Florence help')}&body=${encodeURIComponent(message)}`
        : null;

    return (
        <div className={s.page}>
            <AppBar title="Contact support" />
            <main className={s.content}>
                <h2 className={s.title}>Talk to a person</h2>
                <p className={s.lead}>
                    Support happens on WhatsApp. We add your account details so you don’t have to
                    explain twice.
                </p>
                <section className={s.preview} aria-label="Message we’ll send">
                    <p className={s.label}>Message we’ll send</p>
                    <p className={s.previewText}>Hi Florence, I need help with…</p>
                    <p className={s.previewText}>{footer}</p>
                </section>
                {status.isPending ? <Skeleton height={18} width="60%" /> : null}
                {!status.isPending && !whatsapp && !email ? (
                    <p className={s.caption}>
                        Support contacts aren’t set up yet. Try again later.
                    </p>
                ) : null}
            </main>
            <div className={s.spacer} />
            <footer className={s.footer}>
                {whatsapp ? (
                    <Button
                        block
                        onClick={() => window.open(whatsapp, '_blank', 'noopener,noreferrer')}
                    >
                        Chat on WhatsApp
                    </Button>
                ) : null}
                {email ? (
                    <Button
                        variant={whatsapp ? 'link' : 'primary'}
                        block
                        onClick={() => leaveTo(email)}
                    >
                        Email us instead
                    </Button>
                ) : null}
            </footer>
        </div>
    );
}
