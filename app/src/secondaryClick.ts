// WebKit can report the click following a secondary-button gesture as a
// primary click. Keep the originating pointer button until that click arrives.
export class SecondaryClickGuard {
  private secondaryPointer = false;
  private suppress = false;

  pointerDown(button: number) {
    this.secondaryPointer = button !== 0;
    this.suppress = this.secondaryPointer;
    return this.secondaryPointer;
  }

  contextMenu(button: number) {
    if (button !== 0) {
      this.secondaryPointer = true;
      this.suppress = true;
    }
  }

  click(detail: number) {
    if (detail === 0 && !this.secondaryPointer) {
      this.suppress = false;
      return false;
    }
    const ignored = this.suppress;
    this.suppress = false;
    this.secondaryPointer = false;
    return ignored;
  }
}
