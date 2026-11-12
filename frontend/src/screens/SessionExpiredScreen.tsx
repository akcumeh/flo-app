import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button, EmptyState } from '../components/ui';
import s from './Auth.module.scss';

export function SessionExpiredScreen({ from }: { from: string }) {
    const navigate = useNavigate();
    return (
        <div className={s.page}>
            <main className={s.panel}>
                <EmptyState
                    icon={<Icon name="lock" />}
                    title="Please log in again"
                    body="You've been logged out to keep your account safe. You'll come back to exactly where you were."
                    actions={
                        <Button
                            block
                            onClick={() => navigate('/signin', { replace: true, state: { from } })}
                        >
                            Log in
                        </Button>
                    }
                />
            </main>
        </div>
    );
}
