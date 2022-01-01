import { BehaviorSubject } from 'rxjs';

export class CloudSubject<T> extends BehaviorSubject<T> {
  initialized: boolean = false;

  unsubscribe(): void {
    this.initialized = false;
    super.unsubscribe();
  }
}
