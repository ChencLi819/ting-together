'use strict';

Component({
  properties: {
    track: {
      type: Object,
      value: {},
    },
    addable: { type: Boolean, value: false },
    removable: { type: Boolean, value: false },
    addText: { type: String, value: '点歌' },
    disabled: { type: Boolean, value: false },
    subBadge: { type: String, value: '' },
    qid: { type: String, value: '' },
    /** 队列场景：点整行立即播放 */
    tappable: { type: Boolean, value: false },
  },

  data: {
    coverOk: true,
  },

  methods: {
    onCoverError() {
      this.setData({ coverOk: false });
    },
    onTap() {
      if (!this.data.tappable) return;
      this.triggerEvent('playitem', { qid: this.data.qid, track: this.data.track });
    },
    onAdd() {
      if (this.data.disabled) return;
      this.triggerEvent('add', { track: this.data.track });
    },
    onRemove() {
      this.triggerEvent('remove', { qid: this.data.qid, track: this.data.track });
    },
  },
});
