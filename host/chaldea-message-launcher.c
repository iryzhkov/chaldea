/* Install the statically linked executable as BOTH the account login shell and
 * the forced-command path. A shell script would run after BASH_ENV/LD_*.
 * Build: cc -static -O2 -Wall -Wextra -Werror -o chaldea-message-receive this.c
 * No setuid bit. Runtime/code/config paths are root-owned and fixed at build.
 */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#ifndef MESSAGE_NODE
#define MESSAGE_NODE "/usr/bin/node"
#endif
#ifndef MESSAGE_RECEIVER
#define MESSAGE_RECEIVER "/usr/local/lib/chaldea/src/message-receiver.ts"
#endif
#ifndef MESSAGE_CONFIG
#define MESSAGE_CONFIG "/etc/chaldea/message-receiver.json"
#endif
#define PREFIX "/usr/local/libexec/chaldea-message-receive --caller "
int main(int argc, char **argv) {
  const char *original = getenv("SSH_ORIGINAL_COMMAND");
  const char *connection = getenv("SSH_CONNECTION");
  char caller[129], peer[288];
  if (argc != 3 || strcmp(argv[1], "-c") ||
      strncmp(argv[2], PREFIX, sizeof(PREFIX)-1)) return 1;
  const char *id = argv[2]+sizeof(PREFIX)-1;
  size_t length = strlen(id);
  if (!length || length > 128) return 1;
  for (size_t i=0;i<length;i++) {
    char c=id[i];
    if (!((c>='a'&&c<='z') || (c>='A'&&c<='Z') ||
          (c>='0'&&c<='9') || (i>0 && (c=='.'||c=='_'||c=='-')))) return 1;
  }
  if (!original || strcmp(original,"chaldea-message-v1") ||
      !connection || strlen(connection)>255) return 1;
  memcpy(caller,id,length+1);
  if (snprintf(peer,sizeof(peer),"SSH_CONNECTION=%s",connection)<0) return 1;
  char *clean[]={"PATH=/usr/bin:/bin","SSH_ORIGINAL_COMMAND=chaldea-message-v1",peer,NULL};
  char *args[]={MESSAGE_NODE,MESSAGE_RECEIVER,MESSAGE_CONFIG,caller,NULL};
  struct rlimit core={0,0};
  if (setrlimit(RLIMIT_CORE,&core)) return 1;
  umask(0077);
  alarm(20);
  execve(MESSAGE_NODE,args,clean);
  return 1;
}
