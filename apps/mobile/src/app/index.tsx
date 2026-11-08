// ResQLink home: join the phone-to-phone mesh and send an SOS that works without signal.
// DRAFT — needs a development build on physical phones (Expo Go cannot load the Nearby module). See MESH.md.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { meshService, type MeshStatus } from '@/mesh/mesh-service';

const NO_ROUTE = 255;

function routeText(s: MeshStatus): string {
  if (!s.running) return 'Not connected to the mesh';
  if (s.hasSignal) return 'You have signal: you relay SOS messages for phones nearby';
  if (s.hopsToSignal >= NO_ROUTE) return s.neighbors > 0 ? 'No signal. Looking for a route through nearby phones…' : 'No signal and no phones in range yet';
  return 'No signal. Your SOS will be passed through nearby phones to one with signal';
}

export default function HomeScreen() {
  const theme = useTheme();
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => meshService.subscribe(setStatus), []);
  useEffect(() => {
    void meshService.savedName().then(n => setName(prev => prev || n));
  }, []);

  const s = status;
  const input = [styles.input, { color: theme.text, borderColor: theme.backgroundSelected }];

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="title" style={styles.center}>
            ResQLink
          </ThemedText>
          <ThemedText type="small" style={styles.center} themeColor="textSecondary">
            Offline SOS relay prototype. Not a replacement for 911 and delivery is not guaranteed.
          </ThemedText>

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">{routeText(s ?? ({ running: false } as MeshStatus))}</ThemedText>
            {s?.running && (
              <ThemedText type="small" themeColor="textSecondary">
                {s.neighbors} phone{s.neighbors === 1 ? '' : 's'} connected · carrying {s.carried} message{s.carried === 1 ? '' : 's'} · SOS sent {s.sosSent}
              </ThemedText>
            )}
            {s?.error && <ThemedText type="small" style={styles.error}>{s.error}</ThemedText>}
          </ThemedView>

          {!s?.running ? (
            <View style={styles.block}>
              <ThemedText type="smallBold">Your name (shown to responders)</ThemedText>
              <TextInput style={input} value={name} onChangeText={setName} placeholder="e.g. Maria G." placeholderTextColor={theme.textSecondary} maxLength={60} />
              <Pressable
                style={[styles.button, { backgroundColor: '#208AEF', opacity: name.trim() ? 1 : 0.5 }]}
                disabled={!name.trim()}
                onPress={() => void meshService.start(name.trim())}
              >
                <ThemedText type="smallBold" style={styles.buttonText}>
                  Join the mesh
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.block}>
              <ThemedText type="smallBold">What do you need? (optional)</ThemedText>
              <TextInput style={input} value={note} onChangeText={setNote} placeholder="e.g. trapped upstairs, 2 people" placeholderTextColor={theme.textSecondary} maxLength={160} />
              <Pressable
                style={[styles.button, styles.sos]}
                onPress={() => {
                  void meshService.sendSos(note.trim());
                  setNote('');
                }}
              >
                <ThemedText type="subtitle" style={styles.buttonText}>
                  SEND SOS
                </ThemedText>
              </Pressable>
              <Pressable style={[styles.button, { backgroundColor: theme.backgroundSelected }]} onPress={() => void meshService.stop()}>
                <ThemedText type="small">Leave the mesh</ThemedText>
              </Pressable>
            </View>
          )}

          {s && s.log.length > 0 && (
            <ThemedView type="backgroundElement" style={styles.card}>
              <ThemedText type="smallBold">Activity</ThemedText>
              {s.log.slice(0, 12).map((l, i) => (
                <ThemedText key={i} type="code">
                  {l}
                </ThemedText>
              ))}
            </ThemedView>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', justifyContent: 'center' },
  safeArea: { flex: 1, maxWidth: MaxContentWidth, paddingBottom: BottomTabInset },
  scroll: { padding: Spacing.four, gap: Spacing.three },
  center: { textAlign: 'center' },
  card: { gap: Spacing.two, padding: Spacing.three, borderRadius: Spacing.three },
  block: { gap: Spacing.two },
  input: { borderWidth: 1, borderRadius: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, fontSize: 16 },
  button: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.three, borderRadius: Spacing.three },
  buttonText: { color: '#ffffff' },
  sos: { backgroundColor: '#C0392B', paddingVertical: Spacing.five },
  error: { color: '#C0392B' },
});
