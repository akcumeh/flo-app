import { Dock } from '../components/Dock';
import { Header, useStreak } from '../components/Header';
import { Card, ErrorState, Skeleton } from '../components/ui';
import s from './Page.module.scss';

export function ProgressScreen() {
    const streak = useStreak();
    return (
        <div className={s.page}>
            <Header />
            <main className={s.body}>
                <h1 className={s.title}>Progress</h1>
                {streak.isError ? (
                    <ErrorState onRetry={() => void streak.refetch()} />
                ) : streak.data ? (
                    <div className={s.pair}>
                        <Card muted label="Streak">
                            <p className={s.label}>Streak</p>
                            <p className={s.big}>{streak.data.current} days</p>
                        </Card>
                        <Card muted label="Longest">
                            <p className={s.label}>Longest</p>
                            <p className={s.big}>{streak.data.longest} days</p>
                        </Card>
                    </div>
                ) : (
                    <Skeleton height={96} radius={24} />
                )}
            </main>
            <Dock />
        </div>
    );
}
