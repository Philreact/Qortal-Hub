package protocol

import (
	"sync"
	"testing"
	"time"
)

func TestReliableDispatcherIsolatesBlockedStreamsAndKeepsOrder(t *testing.T) {
	var d reliableDispatcher
	blocked := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(blocked) }) }
	defer func() { release(); d.workers.Wait() }()
	entered := make(chan struct{})
	control := make(chan struct{})
	ordered := make(chan int, 2)
	if !d.submit("bulk", 64, func(bool) { close(entered); <-blocked }) {
		t.Fatal("rejected bulk")
	}
	<-entered
	d.submit("bulk", 64, func(bool) { ordered <- 1 })
	d.submit("bulk", 64, func(bool) { ordered <- 2 })
	d.submit("control", 64, func(bool) { close(control) })
	select {
	case <-control:
	case <-time.After(time.Second):
		t.Fatal("control blocked behind bulk")
	}
	select {
	case <-ordered:
		t.Fatal("same stream reordered")
	default:
	}
	release()
	for _, expected := range []int{1, 2} {
		select {
		case value := <-ordered:
			if value != expected {
				t.Fatal("out of order")
			}
		case <-time.After(time.Second):
			t.Fatal("queue did not drain")
		}
	}
}

func TestReliableDispatcherBoundsCapacity(t *testing.T) {
	var d reliableDispatcher
	blocked := make(chan struct{})
	defer func() { close(blocked); d.workers.Wait() }()
	if !d.submit("bulk", 4*1024*1024, func(bool) { <-blocked }) {
		t.Fatal("unexpected rejection")
	}
	if d.submit("other", 1, func(bool) {}) {
		t.Fatal("unbounded queued bytes")
	}
}

func TestReliableDispatcherDoesNotRunExpiredQueuedWrites(t *testing.T) {
	var d reliableDispatcher
	blocked, entered := make(chan struct{}), make(chan struct{})
	result := make(chan bool, 1)
	d.submit("bulk", 1, func(bool) { close(entered); <-blocked })
	<-entered
	d.submit("bulk", 1, func(ready bool) { result <- ready })
	d.mu.Lock()
	d.queues["bulk"][0].enqueued = time.Now().Add(-2 * time.Second)
	d.mu.Unlock()
	close(blocked)
	d.workers.Wait()
	if <-result {
		t.Fatal("expired queued write was allowed to send")
	}
}
