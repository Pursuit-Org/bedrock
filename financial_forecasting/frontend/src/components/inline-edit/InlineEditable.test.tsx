/**
 * Behavioural tests for the <InlineEditable> primitive.
 *
 * Mocks `usePermissions` (the only context the primitive consumes) so we can
 * exercise every (sensitivity × record-lock × user-permission) branch without
 * spinning up the API layer.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ── Mock usePermissions before any imports that read it ──────────────────
const mockPermissions = {
  can: jest.fn<boolean, [string]>(),
  isAdmin: false,
  sfUserId: 'user-1' as string | null,
  orgUserId: null,
  isPlatformUnlinked: false,
  profileName: 'RM',
  permissions: {} as Record<string, boolean>,
  loading: false,
  refetch: jest.fn(),
};

jest.mock('../../contexts/PermissionsContext', () => ({
  usePermissions: () => mockPermissions,
}));

import { InlineEditable } from './InlineEditable';

beforeEach(() => {
  mockPermissions.can.mockReturnValue(false);
  mockPermissions.isAdmin = false;
  mockPermissions.sfUserId = 'user-1';
});

// Common props used across most tests. A safe field (Opportunity Name).
const safeProps = {
  objectType: 'Opportunity',
  fieldName: 'Name',
  variant: 'text' as const,
  onSave: jest.fn().mockResolvedValue(undefined),
};

describe('InlineEditable — display + safe field', () => {
  it('renders the value in display mode', () => {
    render(<InlineEditable {...safeProps} value="ACME Corp" />);
    expect(screen.getByText('ACME Corp')).toBeInTheDocument();
  });

  it('renders the placeholder when value is empty', () => {
    render(<InlineEditable {...safeProps} value="" placeholder="—" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('does NOT show a lock icon for safe fields', () => {
    render(<InlineEditable {...safeProps} value="ACME Corp" />);
    // The lock IconButton has aria-label via Tooltip but is hidden via CSS;
    // for safe fields the entire badge is omitted.
    expect(screen.queryByTestId('LockIcon')).not.toBeInTheDocument();
  });

  it('enters edit mode when clicked (text variant → TextField in place)', () => {
    render(<InlineEditable {...safeProps} value="ACME Corp" />);
    fireEvent.click(screen.getByText('ACME Corp'));
    // After clicking, the TextField with the value is rendered.
    const input = screen.getByDisplayValue('ACME Corp') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
  });

  it('saves on Enter and exits edit mode', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<InlineEditable {...safeProps} onSave={onSave} value="ACME Corp" />);
    fireEvent.click(screen.getByText('ACME Corp'));
    const input = screen.getByDisplayValue('ACME Corp');
    fireEvent.change(input, { target: { value: 'ACME Inc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ACME Inc'));
  });

  it('does NOT call onSave when the value is unchanged', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<InlineEditable {...safeProps} onSave={onSave} value="ACME Corp" />);
    fireEvent.click(screen.getByText('ACME Corp'));
    const input = screen.getByDisplayValue('ACME Corp');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByDisplayValue('ACME Corp')).not.toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('reverts on Escape and exits edit mode without calling onSave', () => {
    const onSave = jest.fn();
    render(<InlineEditable {...safeProps} onSave={onSave} value="ACME Corp" />);
    fireEvent.click(screen.getByText('ACME Corp'));
    const input = screen.getByDisplayValue('ACME Corp');
    fireEvent.change(input, { target: { value: 'TYPO' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    // Original value is back in display mode.
    expect(screen.getByText('ACME Corp')).toBeInTheDocument();
  });

  it('runs the validate function and surfaces errors', async () => {
    const onSave = jest.fn();
    const validate = jest.fn((v: string) => (v.length < 3 ? 'Too short' : null));
    render(<InlineEditable {...safeProps} onSave={onSave} value="ACME Corp" validate={validate} />);
    fireEvent.click(screen.getByText('ACME Corp'));
    const input = screen.getByDisplayValue('ACME Corp');
    fireEvent.change(input, { target: { value: 'AB' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(validate).toHaveBeenCalledWith('AB');
    expect(await screen.findByText('Too short')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('InlineEditable — sensitive field', () => {
  // Opportunity.StageName is classified sensitive.
  const sensitiveProps = {
    objectType: 'Opportunity',
    fieldName: 'StageName',
    variant: 'select' as const,
    options: [
      { value: 'Lead Gen', label: 'Lead Gen' },
      { value: 'Qualifying', label: 'Qualifying' },
    ],
    onSave: jest.fn().mockResolvedValue(undefined),
  };

  it('renders a hidden lock badge for sensitive fields', () => {
    const { container } = render(<InlineEditable {...sensitiveProps} value="Lead Gen" />);
    // Lock icon is in the DOM but visibility-hidden until parent hover.
    const lockSvg = container.querySelector('[data-testid="LockIcon"]');
    expect(lockSvg).toBeInTheDocument();
  });

  it('shows the unlock dialog on click instead of opening the editor', () => {
    render(<InlineEditable {...sensitiveProps} value="Lead Gen" />);
    fireEvent.click(screen.getByText('Lead Gen'));
    expect(screen.getByText(/Edit sensitive field/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage changes affect pipeline/i)).toBeInTheDocument();
  });

  it('opens the editor after the user confirms the unlock', () => {
    render(<InlineEditable {...sensitiveProps} value="Lead Gen" />);
    fireEvent.click(screen.getByText('Lead Gen'));
    fireEvent.click(screen.getByRole('button', { name: /Unlock to edit/i }));
    // The Menu (select editor) should now be open with the options.
    expect(screen.getByRole('menuitem', { name: 'Lead Gen' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Qualifying' })).toBeInTheDocument();
  });

  it('cancelling the unlock dialog returns to display without entering edit mode', async () => {
    render(<InlineEditable {...sensitiveProps} value="Lead Gen" />);
    fireEvent.click(screen.getByText('Lead Gen'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    // MUI Dialog has a close transition — wait for the role to disappear.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});

describe('InlineEditable — permission-gated field', () => {
  // Project.status is classified permission-gated requiring 'edit_project_status'.
  const gatedProps = {
    objectType: 'Project',
    fieldName: 'status',
    variant: 'select' as const,
    options: [
      { value: 'On Track', label: 'On Track' },
      { value: 'At Risk', label: 'At Risk' },
    ],
    onSave: jest.fn().mockResolvedValue(undefined),
  };

  it('shows a sticky "no permission" tooltip when the user lacks the permission', () => {
    mockPermissions.can.mockReturnValue(false);
    render(<InlineEditable {...gatedProps} value="On Track" />);
    fireEvent.click(screen.getByText('On Track'));
    // Without permission, click should NOT open the unlock dialog or editor.
    expect(screen.queryByText(/Edit sensitive field/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('allows unlock + edit when the user has the permission', () => {
    mockPermissions.can.mockImplementation((key: string) => key === 'edit_project_status');
    render(<InlineEditable {...gatedProps} value="On Track" />);
    fireEvent.click(screen.getByText('On Track'));
    expect(screen.getByText(/Edit sensitive field/i)).toBeInTheDocument();
  });

  it('admin override works regardless of explicit permission', () => {
    mockPermissions.can.mockReturnValue(false);
    mockPermissions.isAdmin = true;
    render(<InlineEditable {...gatedProps} value="On Track" />);
    fireEvent.click(screen.getByText('On Track'));
    expect(screen.getByText(/Edit sensitive field/i)).toBeInTheDocument();
  });
});

describe('InlineEditable — record-level lock by another user', () => {
  it('renders a sticky lock and disables clicks when locked by someone else', () => {
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        recordLock={{ locked_by: 'user-2', locked_at: '2026-04-14T00:00:00Z' }}
        recordLockedByName="Sandra"
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    // Should NOT enter edit mode.
    expect(screen.queryByDisplayValue('ACME Corp')).not.toBeInTheDocument();
  });

  it('treats the record as unlocked when the current user holds the lock', () => {
    mockPermissions.sfUserId = 'user-1';
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        recordLock={{ locked_by: 'user-1', locked_at: '2026-04-14T00:00:00Z' }}
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    // Self-held lock → free edit on a safe field.
    expect(screen.getByDisplayValue('ACME Corp')).toBeInTheDocument();
  });
});

describe('InlineEditable — per-row ownerGate', () => {
  // Mirrors main.py:_enforce_record_ownership: non-admin / non-edit-all users
  // may only edit records they own. Schema-generated cells pass ownerGate
  // per-row; hand-coded cells omit it and fall through to sensitivity-only.
  it('locks a safe field when the user is not the record owner (non-admin, no edit-all)', () => {
    mockPermissions.sfUserId = 'user-1';
    mockPermissions.isAdmin = false;
    mockPermissions.can.mockReturnValue(false);
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        ownerGate={{ rowOwnerId: 'other-user', editAllPermission: 'edit_all_opportunities' }}
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    // Should NOT enter edit mode — ownerGate blocks non-owners.
    expect(screen.queryByDisplayValue('ACME Corp')).not.toBeInTheDocument();
  });

  it('allows edit when the user is admin, regardless of ownership', () => {
    mockPermissions.sfUserId = 'user-1';
    mockPermissions.isAdmin = true;
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        ownerGate={{ rowOwnerId: 'other-user' }}
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    // Admin bypass: free edit on safe field.
    expect(screen.getByDisplayValue('ACME Corp')).toBeInTheDocument();
  });

  it('allows edit when the user holds the edit-all permission for this resource', () => {
    mockPermissions.sfUserId = 'user-1';
    mockPermissions.isAdmin = false;
    mockPermissions.can.mockImplementation((k: string) => k === 'edit_all_opportunities');
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        ownerGate={{ rowOwnerId: 'other-user', editAllPermission: 'edit_all_opportunities' }}
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    expect(screen.getByDisplayValue('ACME Corp')).toBeInTheDocument();
  });

  it('allows edit when the user owns the row', () => {
    mockPermissions.sfUserId = 'user-1';
    mockPermissions.isAdmin = false;
    mockPermissions.can.mockReturnValue(false);
    render(
      <InlineEditable
        {...safeProps}
        value="ACME Corp"
        ownerGate={{ rowOwnerId: 'user-1' }}
      />,
    );
    fireEvent.click(screen.getByText('ACME Corp'));
    expect(screen.getByDisplayValue('ACME Corp')).toBeInTheDocument();
  });
});
