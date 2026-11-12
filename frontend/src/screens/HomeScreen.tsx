import { useQuery } from '@tanstack/react-query';
import { client } from '../api';
import { Dock } from '../components/Dock';
import { Header } from '../components/Header';
import { ErrorState, Skeleton } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import s from './Page.module.scss';

function greeting(now = new Date()): string {
    const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Lagos',
            hour: '2-digit',
            hourCycle: 'h23',
        }).format(now)
    );
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

export function HomeScreen() {
    const { account } = useAccount();
    const home = useQuery({
        queryKey: ['home'],
        queryFn: async () => (await client.GET('/v1/home')).data!,
    });
    const first = account?.displayName?.split(/\s+/)[0];

    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                <h1 className={s.title}>{first ? `${greeting()}, ${first}` : greeting()}</h1>
                {home.isError ? (
                    <ErrorState onRetry={() => void home.refetch()} />
                ) : home.data ? (
                    home.data.exam ? (
                        <p className={s.lead}>
                            {home.data.exam.daysLeft}{' '}
                            {home.data.exam.daysLeft === 1 ? 'day' : 'days'} to your first exam
                        </p>
                    ) : null
                ) : (
                    <div className={s.stack} aria-busy="true">
                        <Skeleton height={22} width="60%" />
                        <Skeleton height={180} radius={24} />
                        <Skeleton height={96} radius={24} />
                    </div>
                )}
            </main>
            <Dock />
        </div>
    );
}
