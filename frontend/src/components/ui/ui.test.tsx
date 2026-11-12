import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { setAppearance } from '../../state/theme';
import { OtpField, Sheet, initials } from './index';

function Otp({ onComplete }: { onComplete: (v: string) => void }) {
    const [v, setV] = useState('');
    return <OtpField label="Code" value={v} onChange={setV} onComplete={onComplete} />;
}

describe('shared parts', () => {
    it('fills all six boxes from one paste and reports the full code', async () => {
        const done = vi.fn();
        const user = userEvent.setup();
        render(<Otp onComplete={done} />);
        await user.click(screen.getByLabelText('Digit 1'));
        await user.paste('482913');
        expect(done).toHaveBeenCalledWith('482913');
        expect(screen.getByLabelText('Digit 6')).toHaveValue('3');
    });

    it('moves back a box on backspace', async () => {
        const user = userEvent.setup();
        render(<Otp onComplete={() => {}} />);
        await user.type(screen.getByLabelText('Digit 1'), '12');
        await user.keyboard('{Backspace}');
        expect(screen.getByLabelText('Digit 1')).toHaveValue('1');
        expect(screen.getByLabelText('Digit 2')).toHaveValue('');
    });

    it('closes a sheet on Escape', async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Sheet open onClose={onClose} title="Add Florence to your home screen">
                <button type="button">Got it</button>
            </Sheet>
        );
        expect(
            screen.getByRole('dialog', { name: 'Add Florence to your home screen' })
        ).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });

    it('sets and clears the theme attribute', () => {
        setAppearance('dark');
        expect(document.documentElement.dataset.theme).toBe('dark');
        setAppearance('system');
        expect(document.documentElement.dataset.theme).toBeUndefined();
    });

    it('makes initials from a display name', () => {
        expect(initials('Tolu Adeyemi')).toBe('TA');
        expect(initials('Ada')).toBe('A');
        expect(initials(null)).toBe('');
    });
});
