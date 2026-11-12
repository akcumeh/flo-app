import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { OptionCard } from '../components/ui';
import { useAppearance, type Appearance } from '../state/theme';
import s from './Auth.module.scss';

const OPTIONS: Array<{ value: Appearance; title: string; body: string }> = [
    { value: 'light', title: 'Light', body: 'Bright background, best outdoors' },
    { value: 'dark', title: 'Dark', body: 'Easier on the eyes at night' },
    { value: 'system', title: 'Match my phone', body: 'Switches with your phone setting' },
];

export function AppearanceScreen() {
    const navigate = useNavigate();
    const [value, setValue] = useAppearance();
    return (
        <div className={s.page}>
            <main className={s.panel}>
                <button
                    type="button"
                    className={s.back}
                    aria-label="Back"
                    onClick={() => navigate(-1)}
                >
                    <Icon name="arrow-left" />
                </button>
                <h1 className={s.title}>Appearance</h1>
                <div className={s.list} role="radiogroup" aria-label="Appearance">
                    {OPTIONS.map((o) => (
                        <OptionCard
                            key={o.value}
                            title={o.title}
                            body={o.body}
                            selected={value === o.value}
                            onSelect={() => setValue(o.value)}
                        />
                    ))}
                </div>
            </main>
        </div>
    );
}
