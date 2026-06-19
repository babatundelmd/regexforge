import { Component, computed, effect, inject, signal, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RegexAgentService } from './services/regex-agent.service';

export interface GoalPreset {
  name: string;
  goal: string;
  testCases: { testString: string; shouldMatch: boolean }[];
}

const PRESETS: GoalPreset[] = [
  {
    name: 'US Phone Number',
    goal: '10-digit US phone numbers with optional area code in parentheses and optional dashes, spaces, or dots.',
    testCases: [
      { testString: '123-456-7890', shouldMatch: true },
      { testString: '(123) 456-7890', shouldMatch: true },
      { testString: '123.456.7890', shouldMatch: true },
      { testString: '1234567890', shouldMatch: true },
      { testString: '123-45-67890', shouldMatch: false },
      { testString: '123-abc-7890', shouldMatch: false },
      { testString: '123456789', shouldMatch: false }
    ]
  },
  {
    name: 'ISO Date',
    goal: 'ISO 8601 calendar date formats: YYYY-MM-DD (e.g. 2026-06-18), forcing valid month (01-12) and day (01-31) ranges.',
    testCases: [
      { testString: '2026-06-18', shouldMatch: true },
      { testString: '1999-12-31', shouldMatch: true },
      { testString: '2026-13-18', shouldMatch: false },
      { testString: '2026-06-32', shouldMatch: false },
      { testString: '26-06-18', shouldMatch: false },
      { testString: '2026/06/18', shouldMatch: false },
      { testString: '2026-6-18', shouldMatch: false }
    ]
  },
  {
    name: 'Hex Color',
    goal: 'A valid hex color code, starting with an optional hashtag (#) followed by either 3 or 6 hex digits, case-insensitive.',
    testCases: [
      { testString: '#FFF', shouldMatch: true },
      { testString: '#ff00aa', shouldMatch: true },
      { testString: '00ffbb', shouldMatch: true },
      { testString: '#G12', shouldMatch: false },
      { testString: '12345', shouldMatch: false },
      { testString: '#1234567', shouldMatch: false }
    ]
  },
  {
    name: 'Password Strength',
    goal: 'Secure passwords: minimum 8 characters long, containing at least one uppercase letter, one lowercase letter, one number, and one special character.',
    testCases: [
      { testString: 'Pass123!', shouldMatch: true },
      { testString: 'aB3$ffff', shouldMatch: true },
      { testString: 'short1!', shouldMatch: false },
      { testString: 'nouppercase1!', shouldMatch: false },
      { testString: 'NoNumbers!', shouldMatch: false },
      { testString: 'NoSpecial123', shouldMatch: false }
    ]
  },
  {
    name: 'IPv4 Address',
    goal: 'Valid IPv4 addresses, composed of four octets separated by dots, each octet ranging from 0 to 255.',
    testCases: [
      { testString: '192.168.1.1', shouldMatch: true },
      { testString: '0.0.0.0', shouldMatch: true },
      { testString: '255.255.255.255', shouldMatch: true },
      { testString: '256.1.1.1', shouldMatch: false },
      { testString: '192.168.1', shouldMatch: false },
      { testString: '192.168.1.1.1', shouldMatch: false }
    ]
  }
];

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  // Service Injection
  protected readonly agentService = inject(RegexAgentService);

  @ViewChild('logContainer') private logContainer!: ElementRef;

  // Constants
  protected readonly presets = PRESETS;

  // Signal State
  protected readonly apiKey = signal<string>('');
  protected readonly goal = signal<string>('');
  protected readonly userTestCases = signal<{ testString: string; shouldMatch: boolean }[]>([]);
  
  // Form Signals
  protected readonly newTestCaseString = signal<string>('');
  protected readonly newTestCaseShouldMatch = signal<boolean>(true);
  
  // UI Helper Signals
  protected readonly activePresetName = signal<string>('');
  protected readonly expandedHistoryIndex = signal<number>(-1);
  protected readonly playgroundString = signal<string>('');
  protected readonly isCopied = signal<boolean>(false);

  protected readonly passedCasesCount = computed(() => {
    return this.agentService.testCases().filter(tc => tc.isMatchValid).length;
  });

  constructor() {
    // Read persisted API Key
    if (typeof window !== 'undefined') {
      const savedKey = localStorage.getItem('gemini_api_key');
      if (savedKey) {
        this.apiKey.set(savedKey);
      }
    }

    // Persist API Key on change
    effect(() => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('gemini_api_key', this.apiKey());
      }
    });

    // Auto-select first preset as initial layout
    if (this.presets.length > 0) {
      this.selectPreset(this.presets[0]);
    }

    // Scroll to bottom when logs change
    effect(() => {
      this.agentService.logs();
      setTimeout(() => {
        this.scrollToBottom();
      }, 50);
    });
  }

  private scrollToBottom(): void {
    try {
      if (this.logContainer) {
        this.logContainer.nativeElement.scrollTop = this.logContainer.nativeElement.scrollHeight;
      }
    } catch (err) {}
  }

  // Preset Selection
  protected selectPreset(preset: GoalPreset) {
    this.activePresetName.set(preset.name);
    this.goal.set(preset.goal);
    // Deep copy test cases
    const copiedCases = preset.testCases.map(tc => ({ ...tc }));
    this.userTestCases.set(copiedCases);
    
    // Reset agent outputs
    if (!this.agentService.isRunning()) {
      this.agentService.status.set('idle');
      this.agentService.currentRegex.set('');
      this.agentService.regexExplanation.set('');
      this.agentService.logs.set([]);
      this.agentService.history.set([]);
      this.agentService.testCases.set([]);
    }
  }

  // Test Case Management
  protected addTestCase() {
    const text = this.newTestCaseString().trim();
    if (!text) return;
    
    // Check for duplicates
    const exists = this.userTestCases().some(tc => tc.testString === text);
    if (exists) return;

    this.userTestCases.update(prev => [
      ...prev,
      { testString: text, shouldMatch: this.newTestCaseShouldMatch() }
    ]);
    
    this.newTestCaseString.set('');
  }

  protected removeTestCase(index: number) {
    this.userTestCases.update(prev => prev.filter((_, i) => i !== index));
  }

  protected toggleTestCaseShouldMatch(index: number) {
    this.userTestCases.update(prev => prev.map((tc, i) => {
      if (i === index) {
        return { ...tc, shouldMatch: !tc.shouldMatch };
      }
      return tc;
    }));
  }

  // Triggering Agent Loop
  protected startAgent() {
    this.agentService.runAgent(
      this.apiKey(),
      this.goal(),
      this.userTestCases()
    );
  }

  protected stopAgent() {
    this.agentService.stopAgent();
  }

  // History Accordion Helper
  protected toggleHistoryExpand(index: number) {
    this.expandedHistoryIndex.update(current => current === index ? -1 : index);
  }

  // Interactive Playground Evaluator
  protected readonly playgroundResult = computed(() => {
    const pattern = this.agentService.currentRegex();
    const isValid = this.agentService.isRegexValid();
    const text = this.playgroundString();
    
    if (!pattern) {
      return { status: 'none', label: 'Waiting for regex...' };
    }
    if (!isValid) {
      return { status: 'error', label: 'Error' };
    }

    try {
      const re = new RegExp(pattern);
      const isMatch = re.test(text);
      
      let groups: string[] = [];
      if (isMatch) {
        const matchResult = text.match(re);
        if (matchResult) {
          // Extract capture groups (excluding index 0 which is full match)
          groups = matchResult.slice(1).filter(g => g !== undefined);
        }
      }

      return {
        status: isMatch ? 'match' : 'no-match',
        label: isMatch ? 'Matches' : 'No Match',
        groups
      };
    } catch (err) {
      return { status: 'error', label: 'Regex Error' };
    }
  });

  // Clipboard Helper
  protected copyRegex() {
    const pattern = this.agentService.currentRegex();
    if (!pattern) return;
    
    navigator.clipboard.writeText(`/${pattern}/`).then(() => {
      this.isCopied.set(true);
      setTimeout(() => this.isCopied.set(false), 2000);
    });
  }
}
